import OpenAI from 'openai';
import type { Episode, Digest } from '../types.js';

export interface SummarizerOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export interface SummaryResult {
  summary: string;
  topics: string[];
  entities: string[];
  decisions: string[];
}

const SYSTEM_PROMPT = `You are a memory summarizer for an AI assistant. Given a batch of conversation episodes, produce a structured summary.

Respond in JSON with exactly this shape:
{
  "summary": "A concise summary of the conversation (2-4 sentences)",
  "topics": ["topic1", "topic2"],
  "entities": ["person or thing mentioned"],
  "decisions": ["any decisions or conclusions reached"]
}

Be concise. Extract only the most important information. If no decisions were made, use an empty array.`;

/**
 * LLM-based summarizer that takes a batch of episodes and produces a digest.
 * Uses OpenAI chat completions (not embeddings) with a structured prompt.
 */
export class Summarizer {
  private client: OpenAI;
  private model: string;
  private maxTokens: number;

  constructor(opts: SummarizerOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? 'gpt-4o-mini';
    this.maxTokens = opts.maxTokens ?? 500;
  }

  /**
   * Summarize a batch of episodes into a structured result.
   */
  async summarize(episodes: Episode[]): Promise<SummaryResult> {
    if (episodes.length === 0) {
      return { summary: '', topics: [], entities: [], decisions: [] };
    }

    const conversationText = episodes
      .map((ep) => `[${ep.role}]: ${ep.content}`)
      .join('\n');

    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: conversationText },
      ],
      max_tokens: this.maxTokens,
      temperature: 0.3,
    });

    const text = resp.choices[0]?.message?.content ?? '{}';
    return this.parseResponse(text);
  }

  /**
   * Summarize episodes and format as a Digest-compatible object.
   */
  async summarizeToDigest(
    sessionId: string,
    episodes: Episode[]
  ): Promise<Omit<Digest, 'id' | 'embedding' | 'created_at'>> {
    const result = await this.summarize(episodes);
    const episodeIds = episodes
      .map((ep) => ep.id)
      .filter((id): id is string => !!id);

    return {
      session_id: sessionId,
      summary: result.summary,
      key_topics: result.topics,
      episode_ids: episodeIds,
      metadata: {
        source: 'summarizer',
        entities: result.entities,
        decisions: result.decisions,
      },
    };
  }

  private parseResponse(text: string): SummaryResult {
    try {
      // Extract JSON from potential markdown code block
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
      const json = JSON.parse(jsonMatch[1] ?? text);
      return {
        summary: json.summary ?? '',
        topics: Array.isArray(json.topics) ? json.topics : [],
        entities: Array.isArray(json.entities) ? json.entities : [],
        decisions: Array.isArray(json.decisions) ? json.decisions : [],
      };
    } catch {
      // Fallback: use raw text as summary
      return {
        summary: text.slice(0, 500),
        topics: [],
        entities: [],
        decisions: [],
      };
    }
  }
}
