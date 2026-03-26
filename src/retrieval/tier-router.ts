import type { TierName } from '../types.js';

export class TierRouter {
  private static readonly EPISODE_PATTERNS = [
    /\b(just|recently|last|earlier|today|now|current)\b/i,
    /\b(said|told|asked|mentioned|wrote)\b/i,
    /\b(this session|this chat|this conversation)\b/i,
  ];

  private static readonly KNOWLEDGE_PATTERNS = [
    /\b(what is|who is|how to|explain|define|meaning)\b/i,
    /\b(always|generally|usually|typically|in general)\b/i,
    /\b(fact|rule|principle|concept|definition)\b/i,
    /\b(preference|like|dislike|favorite|hate)\b/i,
  ];

  private static readonly DIGEST_PATTERNS = [
    /\b(summary|summarize|overview|recap|review)\b/i,
    /\b(previous session|last time|before|history)\b/i,
    /\b(pattern|trend|theme|recurring)\b/i,
  ];

  route(query: string): TierName[] {
    if (!query || query.trim().length === 0) {
      return ['episode', 'digest', 'knowledge'];
    }

    const trimmed = query.trim();

    if (trimmed.length < 20) {
      return ['episode'];
    }

    const tiers = new Set<TierName>();

    if (TierRouter.EPISODE_PATTERNS.some((p) => p.test(trimmed))) {
      tiers.add('episode');
    }
    if (TierRouter.KNOWLEDGE_PATTERNS.some((p) => p.test(trimmed))) {
      tiers.add('knowledge');
    }
    if (TierRouter.DIGEST_PATTERNS.some((p) => p.test(trimmed))) {
      tiers.add('digest');
    }

    if (tiers.size > 0) {
      if (tiers.has('episode') && !tiers.has('digest')) {
        tiers.add('digest');
      }
      if (tiers.has('knowledge') && !tiers.has('digest')) {
        tiers.add('digest');
      }
      return [...tiers];
    }

    if (trimmed.length > 80) {
      return ['episode', 'digest', 'knowledge'];
    }

    return ['episode', 'digest', 'knowledge'];
  }
}
