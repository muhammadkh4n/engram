import OpenAI from 'openai'
import type {
  SummarizeOptions,
  SummaryResult,
  KnowledgeCandidate,
  ExtractedEntity,
  ExtractedEntityType,
  SalienceClassification,
  SalienceCategory,
  SalienceOpts,
} from '@engram-mem/core'

export interface OpenAISummarizerOptions {
  apiKey: string
  model?: string
}

const SUMMARIZE_SYSTEM_PROMPT = `You are a memory summarizer for an AI assistant. Given content from conversation episodes, produce a structured summary.

Respond in JSON with exactly this shape:
{
  "text": "A concise summary of the content (2-4 sentences)",
  "topics": ["topic1", "topic2"],
  "entities": ["person or thing mentioned"],
  "decisions": ["any decisions or conclusions reached"]
}

Be concise. Extract only the most important information. If no decisions were made, use an empty array.`

const KNOWLEDGE_SYSTEM_PROMPT = `You are a knowledge extractor for an AI assistant's memory system. Given content, extract structured knowledge facts.

Respond in JSON with exactly this shape (an array):
[
  {
    "topic": "the subject this knowledge is about",
    "content": "the actual knowledge or fact",
    "confidence": 0.9,
    "sourceDigestIds": [],
    "sourceEpisodeIds": []
  }
]

Extract facts, preferences, decisions, and important patterns. Assign confidence (0-1) based on how clearly stated the knowledge is. Return an empty array if no knowledge can be extracted.`

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

export class OpenAISummarizer {
  private readonly client: OpenAI
  private readonly model: string

  constructor(opts: OpenAISummarizerOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey })
    this.model = opts.model ?? 'gpt-4o-mini'
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

    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      max_tokens: Math.max(opts.targetTokens * 2, 500),
      temperature: 0.3,
    })

    const raw = resp.choices[0]?.message?.content ?? '{}'
    return this.parseSummaryResult(raw, content)
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
    const response = await this.client.chat.completions.create({
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
    return response.choices[0].message.content ?? query
  }

  async expandQuery(query: string): Promise<string[]> {
    // Query expansion for BM25 rescue — generate alternative keyword
    // phrases that might appear in stored conversation turns. The
    // output feeds textBoost() which does tsquery OR-matching.
    //
    // Key behaviors:
    // - Always include the ORIGINAL proper nouns from the query (they
    //   are the strongest retrieval signal and should never be
    //   rephrased away).
    // - For temporal queries, emit both the relative phrase ("last
    //   week") and plausible concrete dates ("May 7", "2023-05-07")
    //   since stored turns often contain both forms.
    // - Focus on nouns/verbs/entities, not stopwords. BM25 weights
    //   IDF naturally, but short queries get dropped entirely if
    //   they're all stopwords.
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            [
              'You generate keyword variants for retrieval from past conversations.',
              '',
              'Given a question, output 4-6 alternative phrases that might appear',
              'verbatim in the stored dialogue turns answering the question.',
              '',
              'Rules:',
              '1. INCLUDE every proper noun from the question unchanged (names, places, products).',
              '2. For temporal queries, include BOTH relative phrases ("last week") AND',
              '   plausible concrete forms ("Monday", "May 7", "last month", "2023").',
              '3. Prefer nouns, verbs, and named entities. Skip articles and auxiliaries.',
              '4. Output ONLY a JSON array of strings, no explanation.',
              '',
              'Examples:',
              '- Q: "Where did Alice and Bob meet?"',
              '  A: ["Alice Bob", "Alice met Bob", "Bob and Alice", "first time meeting", "meeting place"]',
              '- Q: "What did we discuss last week?"',
              '  A: ["last week", "discussed", "previous week", "Monday Tuesday Wednesday", "talked about"]',
            ].join('\n'),
        },
        { role: 'user', content: query },
      ],
      max_tokens: 100,
      temperature: 0.5,
    })

    const raw = response.choices[0]?.message?.content ?? '[]'
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 5)
      }
    } catch {
      // parse failed — return empty
    }
    return []
  }

  async extractKnowledge(content: string): Promise<KnowledgeCandidate[]> {
    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: KNOWLEDGE_SYSTEM_PROMPT },
        { role: 'user', content: content },
      ],
      max_tokens: 1000,
      temperature: 0.2,
    })

    const raw = resp.choices[0]?.message?.content ?? '[]'
    return this.parseKnowledgeCandidates(raw)
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
      const resp = await this.client.chat.completions.create({
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
   * Uses gpt-4o-mini with JSON response format. Default-rejects: returns
   * store=false with low confidence when in doubt. On any API or parse
   * failure, returns a rejection result rather than throwing so the
   * caller's ingestion pipeline is not blocked.
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

    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: SALIENCE_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 400,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      })

      const raw = resp.choices[0]?.message?.content ?? '{}'
      return this.parseSalience(raw)
    } catch (err) {
      process.stderr.write(
        `[openai] extractSalience failed: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return {
        store: false,
        category: 'none',
        confidence: 0,
        distilled: '',
        reason: 'classifier_error',
      }
    }
  }

  private parseSalience(raw: string): SalienceClassification {
    const validCategories: Set<SalienceCategory> = new Set([
      'fact', 'preference', 'decision', 'lesson', 'milestone',
      'identity', 'context_switch', 'plan', 'risk', 'external_fact',
      'emotional_signal', 'none',
    ])

    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) {
        return { store: false, category: 'none', confidence: 0, distilled: '', reason: 'parse_error' }
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
    } catch {
      return { store: false, category: 'none', confidence: 0, distilled: '', reason: 'parse_error' }
    }
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
      const resp = await this.client.chat.completions.create({
        model: 'gpt-4.1-mini',
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

    // Cap at 25 candidates — beyond that, diminishing returns
    const candidates = documents.slice(0, 25)

    const docList = candidates
      .map((d, i) => `[${i}] ${d.content.slice(0, 300)}`)
      .join('\n')

    try {
      const resp = await this.client.chat.completions.create({
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
        max_tokens: 400,
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

  private parseSummaryResult(raw: string, originalContent: string): SummaryResult {
    try {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, raw]
      const parsed: unknown = JSON.parse(jsonMatch[1] ?? raw)

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Not a plain object')
      }

      const obj = parsed as Record<string, unknown>

      return {
        text: typeof obj['text'] === 'string' ? obj['text'] : originalContent.slice(0, 500),
        topics: Array.isArray(obj['topics'])
          ? (obj['topics'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
        entities: Array.isArray(obj['entities'])
          ? (obj['entities'] as unknown[]).filter((e): e is string => typeof e === 'string')
          : [],
        decisions: Array.isArray(obj['decisions'])
          ? (obj['decisions'] as unknown[]).filter((d): d is string => typeof d === 'string')
          : [],
      }
    } catch {
      // Graceful fallback to raw text
      return {
        text: raw.slice(0, 500),
        topics: [],
        entities: [],
        decisions: [],
      }
    }
  }

  private parseKnowledgeCandidates(raw: string): KnowledgeCandidate[] {
    try {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, raw]
      const parsed: unknown = JSON.parse(jsonMatch[1] ?? raw)

      if (!Array.isArray(parsed)) {
        return []
      }

      return parsed
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          topic: typeof item['topic'] === 'string' ? item['topic'] : '',
          content: typeof item['content'] === 'string' ? item['content'] : '',
          confidence:
            typeof item['confidence'] === 'number'
              ? Math.min(1, Math.max(0, item['confidence']))
              : 0.5,
          sourceDigestIds: Array.isArray(item['sourceDigestIds'])
            ? (item['sourceDigestIds'] as unknown[]).filter(
                (id): id is string => typeof id === 'string'
              )
            : [],
          sourceEpisodeIds: Array.isArray(item['sourceEpisodeIds'])
            ? (item['sourceEpisodeIds'] as unknown[]).filter(
                (id): id is string => typeof id === 'string'
              )
            : [],
        }))
        .filter((c) => c.topic.length > 0 && c.content.length > 0)
    } catch {
      return []
    }
  }
}
