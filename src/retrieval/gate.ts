import type { SearchResult, RetrievalGateResult, TierName } from '../types.js';

export interface GateOptions {
  minScore: number;
  maxResults: number;
}

const DEFAULT_GATE_OPTIONS: GateOptions = {
  minScore: 0.3,
  maxResults: 10,
};

/**
 * Patterns that indicate retrieval is NOT needed (low-signal messages).
 */
const SKIP_PATTERNS: RegExp[] = [
  /^(hi|hey|hello|yo|sup|hola|greetings|good\s*(morning|afternoon|evening|night))[\s!?.]*$/i,
  /^(ok|okay|k|sure|yep|yeah|yes|no|nah|nope|fine|cool|nice|great|thanks|thank you|thx|ty|np)[\s!?.]*$/i,
  /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u,
  /^(lol|lmao|haha|heh|rofl|xd)[\s!?.]*$/i,
  /^HEARTBEAT/i,
  /^\s*$/,
];

/**
 * Patterns that strongly suggest retrieval IS needed.
 */
const TRIGGER_PATTERNS: RegExp[] = [
  // Questions
  /\b(what|who|when|where|why|how|which|can you|do you|did|does|is there|are there)\b.*\?/i,
  /\?$/,
  // Temporal references
  /\b(last\s*(week|month|time|session|year)|yesterday|before|earlier|previously|ago|back when)\b/i,
  // Preference / memory queries
  /\b(remember|recall|my\s*(preference|favorite|name|email|address)|you\s*(told|said|mentioned))\b/i,
  // Explicit memory requests
  /\b(search\s*memory|look\s*up|find\s*(in|from)\s*memory)\b/i,
];

/**
 * Determine whether retrieval should be attempted for the given message text.
 * Uses regex heuristics — no LLM call.
 *
 * @returns true if retrieval should proceed, false to skip.
 */
export function shouldRetrieve(text: string | undefined | null): boolean {
  if (!text || text.trim().length === 0) return false;
  const trimmed = text.trim();

  // Short messages below 3 chars are almost never worth retrieving
  if (trimmed.length < 3) return false;

  // Check skip patterns first
  if (SKIP_PATTERNS.some((p) => p.test(trimmed))) return false;

  // Check trigger patterns
  if (TRIGGER_PATTERNS.some((p) => p.test(trimmed))) return true;

  // Default: retrieve for anything substantial (> ~15 chars)
  return trimmed.length > 15;
}

/**
 * Retrieval gate — filters search results by minimum similarity
 * and caps the number of results returned.
 *
 * Also provides a pre-filter check (shouldRetrieve) to decide
 * whether retrieval should be attempted at all.
 */
export class RetrievalGate {
  private opts: GateOptions;

  constructor(opts?: Partial<GateOptions>) {
    this.opts = { ...DEFAULT_GATE_OPTIONS, ...opts };
  }

  /**
   * Pre-filter: should we even attempt retrieval for this message?
   */
  shouldRetrieve(text: string | undefined | null): boolean {
    return shouldRetrieve(text);
  }

  filter<T>(results: SearchResult<T>[], tier: TierName): RetrievalGateResult<T> {
    const qualifying = results.filter((r) => r.similarity >= this.opts.minScore);
    const sorted = qualifying.sort((a, b) => b.similarity - a.similarity);
    const capped = sorted.slice(0, this.opts.maxResults);

    return {
      results: capped,
      filtered: results.length - capped.length,
      tier,
    };
  }

  getMinScore(): number {
    return this.opts.minScore;
  }

  getMaxResults(): number {
    return this.opts.maxResults;
  }
}
