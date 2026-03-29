import OpenAI from 'openai'
import type { SummarizeOptions, SummaryResult, KnowledgeCandidate } from '@engram/core'

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
