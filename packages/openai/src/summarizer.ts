import OpenAI from 'openai'
import type {
  SummarizeOptions,
  SummaryResult,
  KnowledgeCandidate,
  ExtractedEntity,
  ExtractedEntityType,
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
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'Given a query about past conversations or memories, write a short paragraph (2-3 sentences) that would be the CONTENT of the memory being searched for. Do not explain or answer the question — write what the stored memory would contain. Be specific and include likely keywords.',
        },
        { role: 'user', content: query },
      ],
      max_tokens: 150,
      temperature: 0.7,
    })
    return response.choices[0].message.content ?? query
  }

  async expandQuery(query: string): Promise<string[]> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content:
            'Given a search query about past conversations or memories, generate 3-5 alternative keyword phrases that might appear in the stored content. Output ONLY a JSON array of strings. Do not explain. Focus on nouns, tools, technologies, and action words that the stored content would contain.',
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
