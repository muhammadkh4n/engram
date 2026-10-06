import OpenAI from 'openai'
import type {
  SummarizeOptions,
  SummaryResult,
  ExtractFactsInput,
  ExtractedFact,
  FactSourceEpisode,
  ExtractedEntity,
  ExtractedEntityType,
  SalienceClassification,
  SalienceCategory,
  SalienceOpts,
  ExpandQueryOpts,
  EvidenceItem,
  EvidenceSelection,
  SupersessionFact,
  SupersessionCandidate,
  SupersessionVerdict,
  SupersessionStatedAt,
  CompleteJsonRequest,
  CompleteJsonResult,
} from '@engram-mem/core'
import {
  EmptyClassifierReplyError,
  EmptyFactReplyError,
  FactExtractionError,
  SUPERSESSION_NEW_FACT_KEY,
  UnclassifiableReplyError,
  extractJsonReply,
  isSupersessionFactKind,
} from '@engram-mem/core'
import { assertTimeZone, calendarDateIn, weekdayIn } from './time-zone.js'

export interface OpenAISummarizerOptions {
  apiKey: string
  model?: string
  /** Chat-completions endpoint override (any OpenAI-compatible host, e.g.
   *  OpenRouter). Omitted → the SDK's default api.openai.com endpoint. */
  baseURL?: string
  /** OpenRouter provider-routing preferences, sent verbatim as the request
   *  body's `provider` field on every chat call (order/only/ignore/
   *  quantizations/allow_fallbacks — see openrouter.ai/docs/provider-routing).
   *  Non-OpenRouter hosts ignore unknown body fields. Omitted → no field. */
  providerPrefs?: Record<string, unknown>
  /** Reasoning control for reasoning-capable chat models, which count their
   *  reasoning tokens against `max_tokens`:
   *  - omitted: request bodies are sent unchanged;
   *  - `'off'`: every request carries `reasoning: { effort: 'none' }`
   *    (OpenRouter's switch that disables reasoning entirely), caps unchanged;
   *  - `'default'`: no `reasoning` field (the model's own default effort) and
   *    every call's `max_tokens` is raised by `reasoningHeadroom`, so the
   *    visible reply survives the reasoning prefix. */
  reasoning?: ChatReasoningMode
  /** Tokens added to every call's `max_tokens` in `'default'` reasoning mode.
   *  Default 2048. Ignored otherwise. */
  reasoningHeadroom?: number
  /** IANA time zone whose calendar date query expansion states as today's
   *  date. Default `UTC`. An invalid name throws here. */
  timeZone?: string
}

export type ChatReasoningMode = 'off' | 'default'

export const DEFAULT_REASONING_HEADROOM = 2048

type ChatBody = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming

const SUMMARIZE_SYSTEM_PROMPT = `You are a memory summarizer for an AI assistant. Given content from conversation episodes, produce a structured summary.

Respond in JSON with exactly this shape:
{
  "text": "A concise summary of the content (2-4 sentences)",
  "topics": ["topic1", "topic2"],
  "entities": ["person or thing mentioned"],
  "decisions": ["any decisions or conclusions reached"]
}

Be concise. Extract only the most important information. If no decisions were made, use an empty array.`

const FACTS_SYSTEM_PROMPT = `You extract facts for a long-term memory from conversation episodes between a user and an AI assistant. The episodes are numbered E1, E2, and so on; each shows the date and time it was said and who said it (user, assistant or system). The project the conversation belongs to, if any, is named before them.

Write every statement so that a reader who never saw the conversation understands it on its own:
- Name the subject: the person, project or repository, ticket, or system the claim is about.
- Resolve every pronoun and every reference such as "the PR", "this task" or "the bug" to what it names.
- When the claim is a state (what is true, chosen or in use) or an event (something released, merged, fixed, decided or found), give its date, taken from the episode it rests on.

Rules:
- One claim per statement.
- State only what the episodes state: no inference, no guesses, no hedging ("may", "possibly", "seems").
- Skip meta and summary-speak that carries no specific claim, such as "several PRs were merged" or "issues were discussed".
- Skip anything the episodes do not fully state. Never write "not specified", "unknown" or "incomplete".
- Every fact cites the numbers of the episodes it rests on.
- When the episodes hold no such fact, return an empty list.

Reply with only a JSON object of exactly this shape:
{"facts":[{"topic":"short subject label","statement":"the standalone fact","confidence":0.9,"episodes":["E1"]}]}

confidence (0 to 1) is how clearly the episodes state the claim.`

/** Episode text per extraction call. Episodes are never cut, so a single
 *  episode above this goes alone in its own call. */
const FACTS_CHUNK_MAX_CHARS = 24_000
/** Reply budget: a base plus tokens per 1,000 chars of episode text. Facts
 *  scale with the text they are drawn from, not with how many turns carry it;
 *  a per-episode budget starves a few long turns, and their call then fails on
 *  every run. */
const FACTS_REPLY_BASE_TOKENS = 300
const FACTS_REPLY_TOKENS_PER_1K_CHARS = 110
const FACTS_REPLY_MAX_TOKENS = 3_000

interface FactEpisodeChunk {
  episodes: FactSourceEpisode[]
  /** Summed `content.length` of the chunk's episodes. */
  chars: number
}

const ENTITY_SYSTEM_PROMPT = `You are a named-entity extractor for a cognitive memory graph. Given text from a conversation episode, identify REAL entities worth storing as graph nodes for retrieval.

Return JSON with this exact shape:
{
  "entities": [
    { "name": "string", "type": "person" | "org" | "tech" | "project" | "concept", "confidence": 0.0 }
  ]
}

ENTITY TYPES:

1. **person** — Real named individuals. A capitalized first name acting as a sentence subject or being referenced by others is almost always a person. EXTRACT people AGGRESSIVELY: if the text contains "Sarah said...", "Brian had a concern...", "Muhammad wants...", "tell Ahmad that...", "Danyal pointed out...", ALL of these are clear person mentions and MUST be extracted. Do NOT skip people just because the surrounding text is technical. People mentioned inside code/technical discussions still count: "Brian had a concern about TEMPORAL edges" → Brian is a person.
   - Do NOT include pronouns ("I", "you", "he", "she", "they"), role descriptions ("the engineer", "the team"), or hypothetical references.

2. **org** — Companies, teams, institutions (Anthropic, OpenAI, Google, Vercel, "the Plane team", UC Berkeley).

3. **tech** — Specific technologies, libraries, tools, languages, databases (TypeScript, Neo4j, Supabase, Docker, PostgreSQL, React, Cypher).

4. **project** — Named projects or products (Engram, Ouija, Claude Code, vps-agent, RexBook).

5. **concept** — Named methodologies, techniques, theories, or abstractions that function as retrievable anchors (Spreading Activation, HyDE, Complementary Learning Systems, CLS, reconsolidation).

DO NOT EXTRACT:
- Pronouns, determiners, or UI labels ("Project Context", "Work Session", "Action Items")
- Generic verbs, activities, or states ("debugging", "deployment", "working")
- Adjectives, adverbs, or emotions
- Dates, times, numeric values, or durations
- Code identifiers or variable names (camelCase words like "previousEpisodeId", "sessionId") UNLESS they are the actual product name
- Technical field names or parameter names

EXAMPLES:

Input: "Brian had a separate concern about TEMPORAL edges breaking across session boundaries."
Output: {"entities":[{"name":"Brian","type":"person","confidence":0.9}]}
(Brian is clearly a person subject. TEMPORAL is a code identifier, not an entity. sessionId is a variable name, not an entity.)

Input: "Sarah suggested tuning the decay parameter to 0.6 for spreading activation."
Output: {"entities":[{"name":"Sarah","type":"person","confidence":0.9},{"name":"Spreading Activation","type":"concept","confidence":0.85}]}

Input: "The Vercel build keeps timing out, Danyal mentioned they hit similar issues with Next.js 14."
Output: {"entities":[{"name":"Vercel","type":"org","confidence":0.9},{"name":"Danyal","type":"person","confidence":0.9},{"name":"Next.js","type":"tech","confidence":0.9}]}

Input: "Right, the previousEpisodeId lookup is per-session so we are already covered."
Output: {"entities":[]}
(No real entities — previousEpisodeId is a variable name, not a product.)

CONFIDENCE:
- 0.9+ : explicit mention with clear role (subject of sentence, directly addressed)
- 0.7-0.9 : first name or single-word with clear context
- 0.5-0.7 : inferred or abbreviated
- Below 0.5 : do not include

Return an empty "entities" array only when there are truly no entities. Deduplicate case-insensitively; prefer the longest/most complete form.`

const SALIENCE_SYSTEM_PROMPT = `You are a salience gate for a cognitive memory system. Your job is to decide whether a single conversation turn contains material worth storing in long-term memory. DEFAULT: REJECT. Only accept when the turn would meaningfully benefit a future session that did not see this conversation.

ACCEPT categories (use exactly these strings):
  fact              - a declared factual claim about the user, their environment, people, projects, or the world
  preference        - user's stated preference or working style
  decision          - a chosen course of action with rationale
  lesson            - a failure explanation or thing-that-did-not-work learning
  milestone         - completed work, merged PR, shipped feature, test suite turning green after failing
  identity          - information about a named person or their role/relationship
  context_switch    - switching to a different project, tool, or topic in a way future sessions should know
  plan              - a stated intent to do something in the future
  risk              - a stated concern, worry, or identified risk
  external_fact     - information newly acquired from external source (docs, API, search result, meeting)
  emotional_signal  - urgency, frustration, or strong sentiment that should inform future priority weighting

REJECT (return store=false, category='none'):
  - small talk, greetings, acknowledgments, filler
  - tool call announcements, formatting, UI noise
  - content trivially rederivable from git log or file contents
  - duplicates of obviously recent memory
  - ambiguous turns of unclear meaning

RULES:
1. Default REJECT. Only accept when confidence >= 0.7.
2. The "distilled" field must be a 1-3 sentence self-contained version a future session could read without the original context. MINIMUM 15 characters.
3. For user turns: distill, do not store verbatim.
4. For assistant turns: distill decisions and lessons as "we decided X because Y" or "X failed because Y, fix is Z".
5. NEVER store: passwords, API keys, OAuth tokens, credit card numbers, SSNs, or any string matching obvious secret patterns (sk-*, ghp_*, pk_live_*, bearer tokens, pem blocks). If the turn contains such content, return store=false with reason='contains_secret'.
6. NEVER store turns under 20 characters unless they are an explicit preference or decision.

Return JSON:
{
  "store": bool,
  "category": "<one of: fact|preference|decision|lesson|milestone|identity|context_switch|plan|risk|external_fact|emotional_signal|none>",
  "confidence": 0.0..1.0,
  "distilled": "string (empty if store=false)",
  "reason": "short explanation"
}

EXAMPLES:

Input (user turn, project=engram): "ok"
Output: {"store":false,"category":"none","confidence":0.95,"distilled":"","reason":"single acknowledgment"}

Input (user turn, project=engram): "Actually I prefer bullet points for status summaries, stop using prose"
Output: {"store":true,"category":"preference","confidence":0.9,"distilled":"MK prefers bullet-point format for status summaries rather than prose","reason":"direct preference correction"}

Input (user turn, project=engram): "Sarah suggested tuning the decay parameter to 0.6"
Output: {"store":true,"category":"fact","confidence":0.85,"distilled":"Sarah recommended decay parameter of 0.6 for spreading activation tuning","reason":"named-person declared fact"}

Input (assistant turn, project=engram): "I'll read the file now"
Output: {"store":false,"category":"none","confidence":0.95,"distilled":"","reason":"tool call announcement"}

Input (assistant turn, project=engram): "Wave 2 is now e2e validated with 16/16 passing after fixing the TEMPORAL edge race condition"
Output: {"store":true,"category":"milestone","confidence":0.9,"distilled":"Wave 2 e2e validation passes 16/16 after fixing TEMPORAL edge race (MERGE both endpoints of previousEpisodeId)","reason":"verified milestone with specific fix detail"}

Input (user turn): "my openai key is sk-proj-abc123"
Output: {"store":false,"category":"none","confidence":1.0,"distilled":"","reason":"contains_secret"}`

function buildSalienceUserMessage(content: string, opts: SalienceOpts): string {
  const parts: string[] = [
    `Turn role: ${opts.turnRole}`,
    `Current project: ${opts.project ?? 'global'}`,
  ]
  if (opts.priorTurn) {
    parts.push(`Prior turn (context only): ${opts.priorTurn.slice(0, 500)}`)
  }
  parts.push('', 'Turn to classify:', content)
  return parts.join('\n')
}

/** Chat model used when none is configured. */
export const DEFAULT_CHAT_MODEL = 'gpt-4o-mini'

/**
 * Docs scored per rerank call. At least the largest slate the recall engine
 * sends (30 fused candidates plus a 15-row lexical reserve): a doc past the
 * cap gets no score and ranks after every scored one.
 */
const RERANK_MAX_CANDIDATES = 50
/** Reply budget per scored doc; a truncated scores array zeroes the tail. */
const RERANK_REPLY_TOKENS_PER_DOC = 16
const RERANK_MIN_REPLY_TOKENS = 400

const SUPERSESSION_SYSTEM_PROMPT = `You maintain a memory of facts about a user and their work. Compare a FACT with each STORED FACT. Every fact shows the date it was stated. Decide only how each stored fact relates to the FACT, whatever their dates:

- "same": the stored fact states the same claim as the FACT, possibly in other words.
- "conflicts": both facts assert the current value of the same attribute of the same subject, and they cannot both be true now. Examples: a decision was changed, a value was updated, a preference was reversed, a tool or setting was switched to something else.
- Neither list: anything else. A different review, run, release, PR aspect, workload or component is a different subject, so it goes in neither list even when the topic is the same. So does a stored fact that adds or omits detail, or that can be true at the same time as the FACT.

Be conservative. A wrong "conflicts" can retire a fact that is still true. When you are unsure about a stored fact, put it in neither list.

Also label the FACT and every STORED FACT with its kind:
- "state": what is currently true: a status, a current value, a preference in force, or a decision or choice in force (what was chosen, what is used, what the plan is now). "Decided to use X" is a state.
- "event": a one-off happening: released, shipped, completed, found, merged, migrated.
- "plan": an intention or a future step.

Use only the ids shown in STORED FACTS, each in at most one list, and the key "new" for the kind of the FACT. Reply with only JSON, exactly this shape:
{"same": ["<id>"], "conflicts": ["<id>"], "kinds": {"new": "<kind>", "<id>": "<kind>"}}
When no stored fact repeats or conflicts with the FACT, both lists are empty: {"same": [], "conflicts": [], "kinds": {"new": "<kind>", "<id>": "<kind>"}}.`

/** Reply budget: the JSON frame and the new fact's kind, plus per candidate
 *  its id quoted once in a list and once as a kind key. */
const SUPERSESSION_REPLY_BASE_TOKENS = 80
const SUPERSESSION_REPLY_TOKENS_PER_CANDIDATE = 80

export type TranscriptDigestKind = 'session-summary' | 'pre-compact'

const SESSION_SUMMARY_SYSTEM_PROMPT = `You summarize Claude Code work sessions. Extract ONLY:
- Key decisions made
- Problems solved (with solutions)
- Architectural choices
- User preferences expressed
- Important facts learned
- Action items / next steps

Skip: file reads, grep output, test runs, routine tool use, small talk.
Output a concise bullet-point summary (max 300 words). Start with a one-line session title.`

const PRE_COMPACT_SYSTEM_PROMPT = `You analyze Claude Code conversations before context compaction.

Extract TWO outputs:

1. MEMORY (for long-term storage):
Bullet points of ONLY high-value items:
- Architectural decisions with rationale
- User preferences / requirements stated
- Non-obvious solutions found
- Important facts learned (credentials, endpoints, configs discovered)
- Bugs found and their root causes
- Action items / next steps agreed on
Skip: routine operations, file reads, test runs, greps, build commands.
Max 200 words.

2. CONTEXT (for immediate re-injection after compaction):
A brief paragraph (max 100 words) summarizing what the user is currently working on and what was just decided, so Claude can resume seamlessly.

Format your response EXACTLY as:
MEMORY:
<bullet points>

CONTEXT:
<paragraph>`

const TRANSCRIPT_DIGEST_PARAMS: Record<
  TranscriptDigestKind,
  { prompt: string; maxTokens: number; temperature: number }
> = {
  'session-summary': { prompt: SESSION_SUMMARY_SYSTEM_PROMPT, maxTokens: 500, temperature: 0.3 },
  'pre-compact': { prompt: PRE_COMPACT_SYSTEM_PROMPT, maxTokens: 600, temperature: 0.2 },
}

/** Splits a pre-compact reply on its MEMORY:/CONTEXT: markers. A reply
 *  without a MEMORY: marker is kept whole as memory. */
function parsePreCompactDigest(output: string): { memory: string; context: string } {
  const memoryMatch = output.match(/MEMORY:\s*([\s\S]*?)(?=CONTEXT:|$)/)
  const contextMatch = output.match(/CONTEXT:\s*([\s\S]*)$/)
  return {
    memory: memoryMatch?.[1]?.trim() ?? output.trim(),
    context: contextMatch?.[1]?.trim() ?? '',
  }
}

export class OpenAISummarizer {
  private readonly client: OpenAI
  private readonly model: string
  /** contextualizeChunk's model: follows the configured model when one is
   *  set (a configured endpoint override must apply to EVERY chat call —
   *  a hardcoded OpenAI model 404s on non-OpenAI hosts), but keeps its own
   *  historical default on unconfigured installs. */
  private readonly contextualizeModel: string
  private readonly providerPrefs: Record<string, unknown> | undefined
  private readonly reasoning: ChatReasoningMode | undefined
  private readonly reasoningHeadroom: number
  private readonly timeZone: string

  constructor(opts: OpenAISummarizerOptions) {
    this.timeZone = assertTimeZone(opts.timeZone ?? 'UTC')
    this.client = new OpenAI({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) })
    this.model = opts.model ?? DEFAULT_CHAT_MODEL
    this.contextualizeModel = opts.model ?? 'gpt-4.1-mini'
    this.providerPrefs = opts.providerPrefs
    this.reasoning = opts.reasoning
    // The headroom is added to every request cap; NaN or a negative value would
    // send an invalid max_tokens that the API rejects on every call.
    const headroom = opts.reasoningHeadroom ?? DEFAULT_REASONING_HEADROOM
    if (!Number.isInteger(headroom) || headroom < 0) {
      throw new Error(`reasoningHeadroom must be a non-negative integer, got ${String(opts.reasoningHeadroom)}`)
    }
    this.reasoningHeadroom = headroom
  }

  /** Single point through which every chat call goes: merges the optional
   *  OpenRouter `provider` routing object and the reasoning control into the
   *  request body, and reports a reply cut off at `max_tokens`. `label` names
   *  the call site in that report. */
  private async chatCreate(label: string, body: ChatBody) {
    const resp = await this.client.chat.completions.create(this.buildChatBody(body))
    this.warnIfTruncated(label, resp)
    return resp
  }

  private buildChatBody(body: ChatBody): ChatBody {
    let out: ChatBody = body
    if (this.providerPrefs) out = { ...out, provider: this.providerPrefs } as ChatBody
    if (this.reasoning === 'off') {
      out = { ...out, reasoning: { effort: 'none' } } as ChatBody
    } else if (this.reasoning === 'default' && typeof out.max_tokens === 'number') {
      out = { ...out, max_tokens: out.max_tokens + this.reasoningHeadroom }
    }
    return out
  }

  /** A reasoning model that exhausts `max_tokens` on reasoning returns an
   *  empty or cut-short reply with no error; one stderr line makes that
   *  visible. Only sizes are logged — never the reply content. */
  private warnIfTruncated(label: string, resp: OpenAI.Chat.Completions.ChatCompletion): void {
    const choice = resp?.choices?.[0]
    if (choice?.finish_reason !== 'length') return
    const visibleChars = choice.message?.content?.length ?? 0
    const reasoningTokens = resp.usage?.completion_tokens_details?.reasoning_tokens
    process.stderr.write(
      `[openai] ${label} output hit max_tokens (visible_chars=${visibleChars}, reasoning_tokens=${reasoningTokens ?? 'n/a'})\n`,
    )
  }

  async summarize(content: string, opts: SummarizeOptions): Promise<SummaryResult> {
    const modeInstruction =
      opts.mode === 'bullet_points'
        ? 'Format the summary as bullet points.'
        : 'Preserve important details in prose form.'

    const detailInstruction =
      opts.detailLevel === 'high'
        ? 'Include as much detail as possible.'
        : opts.detailLevel === 'low'
          ? 'Be very brief and high-level.'
          : 'Balance detail and brevity.'

    const userMessage = [
      `Target length: approximately ${opts.targetTokens} tokens.`,
      modeInstruction,
      detailInstruction,
      '',
      content,
    ].join('\n')

    const resp = await this.chatCreate('summarize', {
      model: this.model,
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      max_tokens: Math.max(opts.targetTokens * 2, 500),
      temperature: 0.3,
    })

    const choice = resp.choices[0]
    // A reply cut at max_tokens can still close its JSON by chance; its text is
    // then a fragment, so it is never parsed (chatCreate has already logged it).
    if (choice?.finish_reason === 'length') {
      throw new Error('summarize: reply cut off at max_tokens')
    }
    return this.parseSummaryResult(choice?.message?.content ?? '')
  }

  async digestTranscript(
    excerpt: string,
    opts: { kind: TranscriptDigestKind },
  ): Promise<{ memory: string; context: string }> {
    const params = TRANSCRIPT_DIGEST_PARAMS[opts.kind]
    const resp = await this.chatCreate(`digestTranscript:${opts.kind}`, {
      model: this.model,
      messages: [
        { role: 'system', content: params.prompt },
        { role: 'user', content: excerpt },
      ],
      max_tokens: params.maxTokens,
      temperature: params.temperature,
    })
    const output = resp.choices[0]?.message?.content ?? ''
    if (opts.kind === 'pre-compact') return parsePreCompactDigest(output)
    return { memory: output.trim(), context: '' }
  }

  async generateHypotheticalDoc(query: string): Promise<string> {
    // HyDE (Hypothetical Document Embeddings): generate a passage
    // that WOULD appear in the stored text if it answered the query.
    // Embedding that passage gives better retrieval than embedding the
    // question itself because conversational storage contains
    // declarative sentences, not interrogatives.
    //
    // Prompt emphasises: (a) include entities verbatim — "Alice" stays
    // "Alice", not "a person", so BM25 overlaps exactly with source
    // text; (b) preserve temporal markers literally — "last week"
    // stays "last week" so the retrieval catches the same phrasing in
    // conversation turns; (c) write in conversational style, not
    // encyclopedic — source is dialogue, not Wikipedia.
    const response = await this.chatCreate('generateHypotheticalDoc', {
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            [
              'You generate hypothetical conversation excerpts for retrieval.',
              '',
              'Given a question about a past conversation, write a 2-3 sentence excerpt',
              'that would appear VERBATIM in the stored turn if it answered the question.',
              '',
              'Rules:',
              '1. Include ALL proper nouns from the question verbatim (names, places, products).',
              '2. Preserve temporal phrases verbatim ("last week", "on Monday", "2023").',
              '3. Write in conversational first/second person — this is dialogue, not an article.',
              '4. Do not explain or answer — write what the stored turn would literally say.',
              '5. If the question has multiple entities, have them appear together in the excerpt.',
            ].join('\n'),
        },
        { role: 'user', content: query },
      ],
      max_tokens: 180,
      temperature: 0.7,
    })
    const doc = response.choices[0]?.message?.content ?? ''
    // An empty reply or a restated question is not a hypothetical document:
    // embedding it would re-run the direct search and fuse a duplicate pass.
    // An empty string tells the retrieval engine to skip HyDE.
    if (doc.trim() === '' || normalizeForEcho(doc) === normalizeForEcho(query)) return ''
    return doc
  }

  /** The calendar date that the expansion prompt states for `now`: its day in
   *  the configured time zone. */
  expansionReferenceDate(now: Date): string {
    return calendarDateIn(now, this.timeZone)
  }

  async expandQuery(query: string, opts?: ExpandQueryOpts): Promise<string[]> {
    // Query expansion for BM25 rescue — generate alternative keyword
    // phrases that might appear in stored conversation turns. The
    // output feeds textBoost() which does tsquery OR-matching.
    //
    // Key behaviors:
    // - Always include the ORIGINAL proper nouns from the query (they
    //   are the strongest retrieval signal and should never be
    //   rephrased away).
    // - For temporal queries with a reference date, emit both the
    //   relative phrase ("last week") and the concrete dates computed
    //   from that date, since stored turns often contain both forms.
    //   Without a reference date the model can only guess dates, and a
    //   guessed date in the OR-terms matches unrelated turns, so the
    //   prompt then asks for relative phrases only.
    // - Focus on nouns/verbs/entities, not stopwords. BM25 weights
    //   IDF naturally, but short queries get dropped entirely if
    //   they're all stopwords.
    const response = await this.chatCreate('expandQuery', {
      model: this.model,
      messages: [
        { role: 'system', content: expansionSystemPrompt(opts?.now, this.timeZone) },
        { role: 'user', content: query },
      ],
      max_tokens: 100,
      temperature: 0.5,
    })

    return parseExpansionTerms(response.choices[0]?.message?.content ?? '')
  }

  /**
   * Synthesis evidence selection (see IntelligenceAdapter.selectEvidence).
   * The model only selects indices, labels instances, and quotes date
   * phrases verbatim — deterministic core code does all arithmetic and
   * counting. Explicit empty selection ({"items": []}) is a first-class
   * outcome: it means "no line matches", and core renders NOTHING for it.
   * Malformed output throws; core degrades to its deterministic tier.
   */
  async selectEvidence(
    query: string,
    evidence: ReadonlyArray<EvidenceItem>,
    opts: { mode: 'temporal' | 'aggregation' },
  ): Promise<EvidenceSelection> {
    const system = [
      'You select evidence lines relevant to a question about a user\'s past conversations.',
      'You NEVER compute dates, durations, or counts — you only select and label.',
      'Reply with JSON: {"items": [{"index": <number from the list>,',
      '  "instance": "<short label; lines describing the SAME real-world event share a label>",',
      '  "dateText": "<explicit date phrase quoted VERBATIM from the line, omit if none>"}]}',
      'Rules:',
      '1. Only include lines that describe the event(s) the question asks about.',
      '2. Same real-world instance → same label; distinct instances → distinct labels.',
      '3. dateText must be copied verbatim from the message text — never invented, never resolved, never taken from the "(conversation dated …)" annotation.',
      '4. If NO line matches the asked-about event, reply exactly {"items": []}.',
    ].join('\n')
    // The date is retrieval metadata (the conversation's date), not part of
    // the message text; rendering it as a leading "[date]" made models quote
    // it as dateText, laundering session dates into content evidence.
    const lines = evidence
      .map((e) => `${e.index}. ${e.text}${e.date ? ` (conversation dated ${e.date})` : ''}`)
      .join('\n')
    const user = `MODE: ${opts.mode}\nQUESTION: ${query}\nEVIDENCE:\n${lines}`

    const resp = await this.chatCreate('selectEvidence', {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 400,
      temperature: 0,
      response_format: { type: 'json_object' },
    })
    const raw = resp.choices[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(raw) as { items?: unknown }
    return { items: Array.isArray(parsed.items) ? (parsed.items as EvidenceSelection['items']) : [] }
  }

  /**
   * Semantic-fact supersession (see IntelligenceAdapter.judgeSupersession).
   * The verdict only ever names candidate ids: anything else the model
   * returns is dropped. An unreadable reply yields an empty verdict, which
   * keeps every candidate live; a failed call rejects.
   */
  async judgeSupersession(
    fact: SupersessionFact,
    candidates: ReadonlyArray<SupersessionCandidate>,
  ): Promise<SupersessionVerdict> {
    if (candidates.length === 0) return emptyVerdict()

    const lines = candidates.map(
      (c) => `- id: ${c.id}\n  stated: ${formatStatedAt(c.statedAt)}\n  topic: ${c.topic}\n  fact: ${c.content}`,
    )
    const user = [
      'FACT:',
      `  stated: ${formatStatedAt(fact.statedAt)}`,
      `  topic: ${fact.topic}`,
      `  fact: ${fact.content}`,
      '',
      'STORED FACTS:',
      ...lines,
    ].join('\n')

    const resp = await this.chatCreate('judgeSupersession', {
      model: this.model,
      messages: [
        { role: 'system', content: SUPERSESSION_SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      max_tokens: SUPERSESSION_REPLY_BASE_TOKENS + SUPERSESSION_REPLY_TOKENS_PER_CANDIDATE * candidates.length,
      temperature: 0,
      response_format: { type: 'json_object' },
    })
    const raw = resp.choices[0]?.message?.content ?? ''
    try {
      return parseSupersessionVerdict(raw, candidates)
    } catch {
      process.stderr.write(
        `[openai] judgeSupersession reply unreadable (${raw.length} chars, ${candidates.length} candidates); no fact retired\n`,
      )
      return emptyVerdict()
    }
  }

  /**
   * Standalone facts from source episodes (see IntelligenceAdapter.extractFacts).
   * Chunks run one after another; any failed chunk rejects the whole batch, so
   * the caller never stores a partial extraction as complete.
   */
  async extractFacts(input: ExtractFactsInput): Promise<ExtractedFact[]> {
    const facts: ExtractedFact[] = []
    for (const chunk of chunkFactEpisodes(input.episodes)) {
      facts.push(...(await this.extractFactsChunk(chunk, input.projectId)))
    }
    return facts
  }

  private async extractFactsChunk(chunk: FactEpisodeChunk, projectId: string | null): Promise<ExtractedFact[]> {
    const { episodes, chars } = chunk
    const resp = await this.chatCreate('extractFacts', {
      model: this.model,
      messages: [
        { role: 'system', content: FACTS_SYSTEM_PROMPT },
        { role: 'user', content: buildFactsUserMessage(episodes, projectId) },
      ],
      max_tokens: Math.min(
        FACTS_REPLY_BASE_TOKENS + Math.ceil((chars * FACTS_REPLY_TOKENS_PER_1K_CHARS) / 1000),
        FACTS_REPLY_MAX_TOKENS,
      ),
      temperature: 0,
      response_format: { type: 'json_object' },
    })
    const choice = resp.choices?.[0]
    const raw = choice?.message?.content ?? ''
    // A 200 with nothing in it, cut off at max_tokens or not, is a provider
    // glitch, not a reply the episodes produced: resending them later can
    // succeed, so it is transient and is never counted against the batch.
    if (raw.trim() === '') {
      throw new EmptyFactReplyError(
        `extractFacts: empty reply (finish_reason=${choice?.finish_reason ?? 'none'}, ${episodes.length} episodes)`,
      )
    }
    // A cut reply can still close its JSON after dropping later facts, so it is
    // never parsed (chatCreate has already logged it).
    if (choice?.finish_reason === 'length') {
      throw new FactExtractionError('length', `extractFacts: reply cut off at max_tokens (${episodes.length} episodes, ${chars} chars)`)
    }
    let reply: Record<string, unknown>
    try {
      reply = extractJsonReply(raw, isFactsReply) as Record<string, unknown>
    } catch {
      throw new FactExtractionError('parse', `extractFacts: reply holds no {"facts": [...]} object (chars=${raw.length})`)
    }
    return parseExtractedFacts(reply['facts'] as unknown[], episodes)
  }

  /**
   * One JSON-mode call at temperature 0 (see IntelligenceAdapter.completeJson).
   * The reply is returned as received: the caller validates it, so this
   * method never parses, retries or swallows an SDK error.
   */
  async completeJson(req: CompleteJsonRequest): Promise<CompleteJsonResult> {
    const resp = await this.chatCreate(req.label, {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: req.maxTokens,
      temperature: 0,
      response_format: { type: 'json_object' },
    })
    const choice = resp.choices?.[0]
    return {
      text: choice?.message?.content ?? '',
      finishReason: choice?.finish_reason ?? null,
      model: resp.model || this.model,
    }
  }

  /**
   * Extract typed named entities from an episode's content.
   *
   * Uses gpt-4o-mini with JSON-response mode. Typical cost per call is
   * ~500 input tokens + ~100 output tokens ≈ $0.00014 at current pricing.
   *
   * Returns an empty array on any parse or network error — the caller
   * must treat extraction as best-effort and fall back to the heuristic
   * regex extractor in @engram-mem/graph when this returns nothing.
   */
  async extractEntities(content: string): Promise<ExtractedEntity[]> {
    // Skip extraction for very short content — nothing meaningful to extract
    // and every call costs at least the minimum billing rate.
    const trimmed = content.trim()
    if (trimmed.length < 30) return []

    try {
      const resp = await this.chatCreate('extractEntities', {
        model: this.model,
        messages: [
          { role: 'system', content: ENTITY_SYSTEM_PROMPT },
          { role: 'user', content: trimmed.slice(0, 6000) },
        ],
        max_tokens: 500,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      })

      const raw = resp.choices[0]?.message?.content ?? '{"entities":[]}'
      return this.parseExtractedEntities(raw)
    } catch (err) {
      // Non-fatal: caller uses regex fallback. Log to stderr so MCP
      // stdio transport stays clean.
      process.stderr.write(
        `[openai] extractEntities failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return []
    }
  }

  /**
   * Salience classification for the Layer 1 & 2 memory ingestion gate.
   *
   * Uses the configured chat model with JSON response format. Default-rejects:
   * the model returns store=false with low confidence when in doubt. A chat
   * API error or unparseable output throws, so the caller can retry the
   * capture instead of recording a verdict the model never gave.
   */
  async extractSalience(
    content: string,
    opts: SalienceOpts,
  ): Promise<SalienceClassification> {
    const trimmed = content.trim()

    // Cheap short-circuit: turns under 15 chars are almost never worth storing
    // (single-word ack, "ok", "yes", "got it"). Save an API call.
    if (trimmed.length < 15) {
      return {
        store: false,
        category: 'none',
        confidence: 0.95,
        distilled: '',
        reason: 'too_short',
      }
    }

    const userMessage = buildSalienceUserMessage(trimmed, opts)

    let raw: string
    try {
      const resp = await this.chatCreate('extractSalience', {
        model: this.model,
        messages: [
          { role: 'system', content: SALIENCE_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 400,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      })
      const choice = resp.choices[0]
      raw = choice?.message?.content ?? ''
      // A 200 with no visible text is a provider glitch or a reasoning model
      // that spent max_tokens before answering. Unlike an unreadable verdict,
      // resending the same turn later can succeed, so it fails like the call.
      if (raw.trim() === '') {
        throw new EmptyClassifierReplyError(
          `extractSalience: empty classifier reply (finish_reason=${choice?.finish_reason ?? 'none'})`,
        )
      }
    } catch (err) {
      process.stderr.write(
        `[openai] extractSalience failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      throw err
    }
    return this.parseSalience(raw)
  }

  private parseSalience(raw: string): SalienceClassification {
    const validCategories: Set<SalienceCategory> = new Set([
      'fact', 'preference', 'decision', 'lesson', 'milestone',
      'identity', 'context_switch', 'plan', 'risk', 'external_fact',
      'emotional_signal', 'none',
    ])

    let parsed: unknown
    try {
      parsed = extractJsonReply(raw, isSalienceVerdict)
    } catch (err) {
      throw new UnclassifiableReplyError(
        `extractSalience: unparseable classifier output (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    const obj = parsed as Record<string, unknown>
    const store = obj['store'] === true
    const rawCategory = typeof obj['category'] === 'string' ? obj['category'] : 'none'
    const category: SalienceCategory = validCategories.has(rawCategory as SalienceCategory)
      ? (rawCategory as SalienceCategory)
      : 'none'
    const confidence =
      typeof obj['confidence'] === 'number'
        ? Math.min(1, Math.max(0, obj['confidence']))
        : 0
    const distilled = typeof obj['distilled'] === 'string' ? obj['distilled'].trim() : ''
    const reason = typeof obj['reason'] === 'string' ? obj['reason'] : ''

    // Guardrail: if the classifier says store but gives no distilled text
    // or the distilled text is shorter than the minimum useful length,
    // reject it. Prevents empty writes.
    if (store && distilled.length < 15) {
      return { store: false, category, confidence, distilled: '', reason: 'empty_distilled' }
    }

    return { store, category, confidence, distilled, reason }
  }

  private parseExtractedEntities(raw: string): ExtractedEntity[] {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return []
      const entities = (parsed as Record<string, unknown>)['entities']
      if (!Array.isArray(entities)) return []

      const validTypes: Set<ExtractedEntityType> = new Set([
        'person', 'org', 'tech', 'project', 'concept',
      ])

      const seen = new Map<string, ExtractedEntity>()

      for (const item of entities) {
        if (typeof item !== 'object' || item === null) continue
        const obj = item as Record<string, unknown>
        const name = typeof obj['name'] === 'string' ? obj['name'].trim() : ''
        const type = obj['type'] as string
        const confidence =
          typeof obj['confidence'] === 'number'
            ? Math.min(1, Math.max(0, obj['confidence']))
            : 0.5

        if (name.length < 2) continue
        if (!validTypes.has(type as ExtractedEntityType)) continue
        if (confidence < 0.5) continue

        // Deduplicate case-insensitively, keep highest confidence
        const key = name.toLowerCase()
        const existing = seen.get(key)
        if (!existing || confidence > existing.confidence) {
          seen.set(key, { name, type: type as ExtractedEntityType, confidence })
        }
      }

      return Array.from(seen.values())
    } catch {
      return []
    }
  }

  /**
   * Anthropic-style Contextual Retrieval preamble generator.
   *
   * Given a chunk (single conversational turn) and its surrounding context
   * (recent turns in the same session), generate 1-2 sentences that situate
   * the chunk — disambiguating pronouns, dates, topics, and subjects that
   * downstream search would otherwise miss.
   *
   * Uses gpt-4.1-mini (a separate RPD bucket from gpt-4o-mini) with a
   * short prompt modelled on Anthropic's published pattern. Non-fatal on
   * failure: returns an empty string so the caller proceeds with the raw
   * chunk. ~$0.0001 per contextualization at current pricing.
   */
  async contextualizeChunk(
    chunk: string,
    opts: { conversationContext: string; speakerRole?: string },
  ): Promise<string> {
    if (chunk.trim().length === 0) return ''
    const context = opts.conversationContext.slice(-2000)
    if (context.trim().length === 0) {
      // First turn or no prior context — nothing to situate against.
      return ''
    }

    try {
      const resp = await this.chatCreate('contextualizeChunk', {
        model: this.contextualizeModel,
        messages: [
          {
            role: 'system',
            content: `You generate short contextual preambles for conversational memory chunks, so a downstream search index can retrieve them without the surrounding dialogue. Produce ONE or TWO short sentences that:
- Identify the speaker by name if derivable from context, not by pronoun
- Resolve any pronouns, demonstratives, or time references ("she" → "Melanie"; "that trip" → "the Paris trip"; "last week" → the concrete period)
- Name the topic succinctly

Do NOT restate the chunk. Do NOT invent facts not present in the context or the chunk. If the context is insufficient to situate the chunk, output an empty string.

Respond with only the preamble sentences. No JSON, no markdown, no quotes.`,
          },
          {
            role: 'user',
            content: `<conversation_context>\n${context}\n</conversation_context>\n\n<chunk role="${opts.speakerRole ?? 'unknown'}">\n${chunk}\n</chunk>\n\nPreamble:`,
          },
        ],
        max_tokens: 80,
        temperature: 0,
      })

      const raw = resp.choices[0]?.message?.content?.trim() ?? ''
      // Guardrail: keep it bounded and scrub accidental markdown wrappers.
      return raw.replace(/^["'`*_]+|["'`*_]+$/g, '').slice(0, 400)
    } catch (err) {
      process.stderr.write(
        `[openai] contextualizeChunk failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return ''
    }
  }

  /**
   * Cross-encoder reranking via LLM pointwise scoring.
   *
   * Sends all candidates in a single prompt, asks for relevance scores.
   * Uses gpt-4o-mini for cost efficiency (~$0.001 per rerank of 20 docs).
   * Documents are truncated to 300 chars each to keep prompt compact.
   */
  async rerank(
    query: string,
    documents: ReadonlyArray<{ id: string; content: string }>,
  ): Promise<Array<{ id: string; score: number }>> {
    if (documents.length === 0) return []
    if (documents.length === 1) return [{ id: documents[0]!.id, score: 1.0 }]

    const candidates = documents.slice(0, RERANK_MAX_CANDIDATES)

    const docList = candidates
      .map((d, i) => `[${i}] ${d.content.slice(0, 300)}`)
      .join('\n')

    try {
      const resp = await this.chatCreate('rerank', {
        model: this.model,
        messages: [
          {
            role: 'system',
            content: `You are a relevance scorer. Given a search query and numbered documents, score each document's relevance to the query on a scale of 0-10.

Return JSON: {"scores": [{"index": 0, "score": 8}, ...]}

Scoring guide:
- 10: directly answers the query with specific details
- 7-9: highly relevant, contains key information
- 4-6: partially relevant, tangentially related
- 1-3: weakly related, mostly noise
- 0: completely irrelevant

Be discriminating — most documents should score below 5. Only score 8+ when the document clearly and specifically addresses the query.`,
          },
          {
            role: 'user',
            content: `Query: "${query}"\n\nDocuments:\n${docList}`,
          },
        ],
        max_tokens: Math.max(RERANK_MIN_REPLY_TOKENS, RERANK_REPLY_TOKENS_PER_DOC * candidates.length),
        temperature: 0,
        response_format: { type: 'json_object' },
      })

      const raw = resp.choices[0]?.message?.content ?? '{"scores":[]}'
      return this.parseRerankScores(raw, candidates)
    } catch (err) {
      process.stderr.write(
        `[openai] rerank failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      // Non-fatal: return original order with descending scores
      return candidates.map((d, i) => ({
        id: d.id,
        score: 1.0 - i * (0.5 / candidates.length),
      }))
    }
  }

  private parseRerankScores(
    raw: string,
    candidates: ReadonlyArray<{ id: string; content: string }>,
  ): Array<{ id: string; score: number }> {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')

      const scores = (parsed as Record<string, unknown>)['scores']
      if (!Array.isArray(scores)) throw new Error('no scores array')

      const result: Array<{ id: string; score: number }> = []
      for (const entry of scores) {
        if (typeof entry !== 'object' || entry === null) continue
        const obj = entry as Record<string, unknown>
        const index = typeof obj['index'] === 'number' ? obj['index'] : -1
        const score = typeof obj['score'] === 'number' ? obj['score'] : 0

        if (index < 0 || index >= candidates.length) continue
        result.push({
          id: candidates[index]!.id,
          score: Math.min(1.0, Math.max(0, score / 10)), // normalize 0-10 → 0-1
        })
      }

      // Fill in any candidates the LLM missed with score 0
      const scored = new Set(result.map(r => r.id))
      for (const c of candidates) {
        if (!scored.has(c.id)) {
          result.push({ id: c.id, score: 0 })
        }
      }

      return result
    } catch {
      // Parse failed — return original order
      return candidates.map((d, i) => ({
        id: d.id,
        score: 1.0 - i * (0.5 / candidates.length),
      }))
    }
  }

  /** Throws rather than guessing: the caller stores `text` as the digest, so a
   *  raw reply or a cut of the source content must never stand in for it. */
  private parseSummaryResult(raw: string): SummaryResult {
    let obj: Record<string, unknown>
    try {
      obj = extractJsonReply(raw, isPlainObject) as Record<string, unknown>
    } catch {
      throw new Error(`summarize: reply holds no JSON object (chars=${raw.length})`)
    }
    const text = obj['text']
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('summarize: reply has no text')
    }
    return {
      text,
      topics: stringsOf(obj['topics']),
      entities: stringsOf(obj['entities']),
      decisions: stringsOf(obj['decisions']),
    }
  }
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSalienceVerdict(value: unknown): boolean {
  return isPlainObject(value) && typeof value['store'] === 'boolean'
}

function emptyVerdict(): SupersessionVerdict {
  return { same: [], conflicts: [], kinds: {} }
}

function isSupersessionVerdict(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const { same, conflicts } = value
  if (same === undefined && conflicts === undefined) return false
  return (same === undefined || Array.isArray(same)) && (conflicts === undefined || Array.isArray(conflicts))
}

/**
 * Keeps only ids from the candidate set, once each. An id the model put in
 * both lists is a self-contradicting verdict and lands in neither, so the
 * candidate stays live and the new fact is stored as new. Kinds are kept only
 * for the new fact and known candidates and only when valid; a missing or
 * invalid kind is left out, which the caller reads as not a state.
 */
function parseSupersessionVerdict(
  raw: string,
  candidates: ReadonlyArray<SupersessionCandidate>,
): SupersessionVerdict {
  const parsed = extractJsonReply(raw, isSupersessionVerdict) as {
    same?: unknown[]
    conflicts?: unknown[]
    kinds?: unknown
  }
  const known = new Set(candidates.map((c) => c.id))
  const pick = (list: unknown[] | undefined): string[] => [
    ...new Set((list ?? []).filter((id): id is string => typeof id === 'string' && known.has(id))),
  ]
  const same = pick(parsed.same)
  const conflicts = pick(parsed.conflicts)
  const both = new Set(conflicts.filter((id) => same.includes(id)))
  return {
    same: same.filter((id) => !both.has(id)),
    conflicts: conflicts.filter((id) => !both.has(id)),
    kinds: pickKinds(parsed.kinds, [SUPERSESSION_NEW_FACT_KEY, ...known]),
  }
}

function pickKinds(raw: unknown, keys: ReadonlyArray<string>): SupersessionVerdict['kinds'] {
  if (!isPlainObject(raw)) return {}
  const kinds: SupersessionVerdict['kinds'] = {}
  for (const key of keys) {
    const kind = Object.hasOwn(raw, key) ? raw[key] : undefined
    if (isSupersessionFactKind(kind)) kinds[key] = kind
  }
  return kinds
}

function isFactsReply(value: unknown): boolean {
  return isPlainObject(value) && Array.isArray(value['facts'])
}

/** Whole-episode chunks of at most FACTS_CHUNK_MAX_CHARS episode text each,
 *  in input order; an episode longer than that is a chunk of its own. */
function chunkFactEpisodes(episodes: ReadonlyArray<FactSourceEpisode>): FactEpisodeChunk[] {
  const chunks: FactEpisodeChunk[] = []
  let current: FactSourceEpisode[] = []
  let chars = 0
  for (const ep of episodes) {
    if (current.length > 0 && chars + ep.content.length > FACTS_CHUNK_MAX_CHARS) {
      chunks.push({ episodes: current, chars })
      current = []
      chars = 0
    }
    current.push(ep)
    chars += ep.content.length
  }
  if (current.length > 0) chunks.push({ episodes: current, chars })
  return chunks
}

function buildFactsUserMessage(episodes: ReadonlyArray<FactSourceEpisode>, projectId: string | null): string {
  const header = projectId ? `Project: ${projectId}` : 'Project: none (not tied to one project)'
  const blocks = episodes.map(
    (ep, i) => `--- E${i + 1} · ${formatStatedAt(ep.createdAt)} · ${ep.role}\n${ep.content}`,
  )
  return [header, '', ...blocks].join('\n')
}

/** Index into the call's episodes for a citation such as "E3" (also "3" or 3),
 *  or -1 when it names no episode of the call. */
function citedEpisodeIndex(citation: unknown, count: number): number {
  let n: number
  if (typeof citation === 'number') {
    n = citation
  } else if (typeof citation === 'string') {
    const m = /^\s*E?(\d+)\s*$/i.exec(citation)
    if (!m) return -1
    n = Number(m[1])
  } else {
    return -1
  }
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : -1
}

/** Keeps facts with a topic, a statement and at least one citation of an
 *  episode in the call; citations become episode ids, deduplicated in order. */
function parseExtractedFacts(items: unknown[], episodes: ReadonlyArray<FactSourceEpisode>): ExtractedFact[] {
  const facts: ExtractedFact[] = []
  for (const item of items) {
    if (!isPlainObject(item)) continue
    const topic = typeof item['topic'] === 'string' ? item['topic'].trim() : ''
    const statement = typeof item['statement'] === 'string' ? item['statement'].trim() : ''
    if (topic === '' || statement === '') continue
    const cited = Array.isArray(item['episodes']) ? item['episodes'] : []
    const episodeIds: string[] = []
    for (const citation of cited) {
      const index = citedEpisodeIndex(citation, episodes.length)
      if (index === -1) continue
      const id = episodes[index]!.id
      if (!episodeIds.includes(id)) episodeIds.push(id)
    }
    if (episodeIds.length === 0) continue
    const rawConfidence = item['confidence']
    const confidence =
      typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
        ? Math.min(1, Math.max(0, rawConfidence))
        : 0.5
    facts.push({ topic, statement, confidence, episodeIds })
  }
  return facts
}

/** ISO timestamp of a statement time, or `unknown date` when absent or unparseable. */
function formatStatedAt(statedAt: SupersessionStatedAt): string {
  if (statedAt === null) return 'unknown date'
  const ms = statedAt instanceof Date ? statedAt.getTime() : Date.parse(statedAt)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown date'
}

const MAX_EXPANSION_TERMS = 5

/**
 * System prompt for query expansion. With a valid reference date the prompt
 * opens with it (its weekday and calendar day in `timeZone`, so a user's
 * "yesterday" resolves against the user's own day, not the server's, and the
 * model never has to work out which weekday today is) and asks for the
 * concrete dates relative phrases resolve to; without one it forbids concrete
 * dates, since any date the model produced would be invented.
 */
function expansionSystemPrompt(now: Date | undefined, timeZone: string): string {
  const today = now !== undefined && !Number.isNaN(now.getTime())
    ? `${weekdayIn(now, timeZone)}, ${calendarDateIn(now, timeZone)}`
    : null
  const temporalRule = today !== null
    ? [
        '2. For temporal queries, include BOTH relative phrases ("last week") AND the',
        '   concrete dates they refer to, computed from today\'s date (weekday names,',
        '   "May 7", "2023-05-07", month names, the year).',
      ]
    : [
        '2. For temporal queries, include relative phrases only ("last week",',
        '   "yesterday", "last month"). Never output a concrete date, weekday, month',
        '   or year the question does not state: the current date is unknown, so',
        '   any computed date would be a guess.',
      ]
  const temporalExample = today !== null
    ? '  A: ["last week", "discussed", "previous week", "Monday Tuesday Wednesday", "talked about"]'
    : '  A: ["last week", "discussed", "previous week", "a week ago", "talked about"]'
  return [
    ...(today !== null ? [`Today's date is ${today}.`, ''] : []),
    'You generate keyword variants for retrieval from past conversations.',
    '',
    'Given a question, output 4-6 alternative phrases that might appear',
    'verbatim in the stored dialogue turns answering the question.',
    '',
    'Rules:',
    '1. INCLUDE every proper noun from the question unchanged (names, places, products).',
    ...temporalRule,
    '3. Prefer nouns, verbs, and named entities. Skip articles and auxiliaries.',
    '4. Output ONLY a JSON array of strings, no explanation.',
    '',
    'Examples:',
    '- Q: "Where did Alice and Bob meet?"',
    '  A: ["Alice Bob", "Alice met Bob", "Bob and Alice", "first time meeting", "meeting place"]',
    '- Q: "What did we discuss last week?"',
    temporalExample,
  ].join('\n')
}

/**
 * The reply should be a JSON array of strings; models also wrap it in prose,
 * a fence, or an object. The first array holding at least one string is used;
 * a reply with none yields no terms.
 */
function parseExpansionTerms(raw: string): string[] {
  try {
    const terms = extractJsonReply(
      raw,
      (value) => Array.isArray(value) && value.some((item) => typeof item === 'string'),
    )
    return cleanExpansionTerms(terms as unknown[])
  } catch {
    return []
  }
}

function cleanExpansionTerms(items: unknown[]): string[] {
  return items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, MAX_EXPANSION_TERMS)
}

function normalizeForEcho(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}`]+|[\s\p{P}`]+$/gu, '')
}
