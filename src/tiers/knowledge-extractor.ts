import type { Digest, Knowledge } from '../types.js';
import type { EmbeddingService } from '../utils/embeddings.js';

export interface ExtractionResult {
  topic: string;
  content: string;
  confidence: number;
  sourceDigestIds: string[];
  metadata?: Record<string, unknown>;
}

/** Patterns for immediate promotion (user explicitly states preference/decision) */
const IMMEDIATE_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /I prefer\s+(.+?)(?:\.|,|$)/gi, category: 'preference' },
  { pattern: /I always\s+(.+?)(?:\.|,|$)/gi, category: 'preference' },
  { pattern: /I never\s+(.+?)(?:\.|,|$)/gi, category: 'preference' },
  { pattern: /I like\s+(.+?)(?:\.|,|$)/gi, category: 'preference' },
  { pattern: /I don't like\s+(.+?)(?:\.|,|$)/gi, category: 'preference' },
  { pattern: /I hate\s+(.+?)(?:\.|,|$)/gi, category: 'preference' },
  { pattern: /let's go with\s+(.+?)(?:\.|,|$)/gi, category: 'decision' },
  { pattern: /we decided to\s+(.+?)(?:\.|,|$)/gi, category: 'decision' },
  { pattern: /the plan is to\s+(.+?)(?:\.|,|$)/gi, category: 'decision' },
  { pattern: /my (?:name|email|timezone|location) is\s+(.+?)(?:\.|,|$)/gi, category: 'personal_info' },
];

/**
 * Knowledge Extractor.
 *
 * Scans episodes/digests for recurring patterns, explicit preferences, decisions.
 * Supports immediate promotion (explicit statements) and batch promotion
 * (patterns occurring 3+ times in 7 days).
 */
export class KnowledgeExtractor {
  private patternCounts: Map<string, { count: number; firstSeen: number; digestIds: string[] }> = new Map();
  private batchThreshold: number;
  private batchWindowDays: number;

  constructor(opts?: { batchThreshold?: number; batchWindowDays?: number }) {
    this.batchThreshold = opts?.batchThreshold ?? 3;
    this.batchWindowDays = opts?.batchWindowDays ?? 7;
  }

  /**
   * Extract knowledge from digests — finds both immediate and batch patterns.
   */
  extractFromDigests(digests: Digest[]): ExtractionResult[] {
    const results: ExtractionResult[] = [];

    for (const digest of digests) {
      // Check for immediate promotion patterns in summary
      const immediateResults = this.extractImmediate(digest);
      results.push(...immediateResults);

      // Track topics for batch promotion
      for (const topic of digest.key_topics) {
        this.trackPattern(topic, digest.id ?? '');
      }
    }

    // Check for batch promotion
    const batchResults = this.extractBatch();
    results.push(...batchResults);

    return results;
  }

  /**
   * Extract immediately promotable knowledge from a single digest.
   */
  extractImmediate(digest: Digest): ExtractionResult[] {
    const results: ExtractionResult[] = [];
    const text = digest.summary;

    for (const { pattern, category } of IMMEDIATE_PATTERNS) {
      // Reset lastIndex for global regex
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const content = match[1].trim();
        if (content.length < 3) continue;

        results.push({
          topic: category,
          content,
          confidence: 0.9, // High confidence for explicit statements
          sourceDigestIds: digest.id ? [digest.id] : [],
          metadata: { extraction: 'immediate', category },
        });
      }
    }

    return results;
  }

  /**
   * Track a pattern occurrence for batch promotion.
   */
  private trackPattern(topic: string, digestId: string): void {
    const key = topic.toLowerCase().trim();
    const existing = this.patternCounts.get(key);
    if (existing) {
      existing.count++;
      if (!existing.digestIds.includes(digestId)) {
        existing.digestIds.push(digestId);
      }
    } else {
      this.patternCounts.set(key, {
        count: 1,
        firstSeen: Date.now(),
        digestIds: [digestId],
      });
    }
  }

  /**
   * Extract batch-promoted knowledge (patterns occurring 3+ times within window).
   */
  private extractBatch(): ExtractionResult[] {
    const results: ExtractionResult[] = [];
    const windowMs = this.batchWindowDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const [topic, data] of this.patternCounts) {
      if (data.count >= this.batchThreshold && (now - data.firstSeen) <= windowMs) {
        const confidence = Math.min(0.5 + (data.count - this.batchThreshold) * 0.1, 0.85);
        results.push({
          topic: 'recurring_topic',
          content: topic,
          confidence,
          sourceDigestIds: data.digestIds,
          metadata: {
            extraction: 'batch',
            occurrences: data.count,
          },
        });
      }
    }

    return results;
  }

  /**
   * Check if new knowledge supersedes existing knowledge.
   * Returns the ID of the superseded knowledge, or null.
   */
  checkSupersession(
    newContent: string,
    existingKnowledge: Knowledge[]
  ): string | null {
    // Simple contradiction detection
    const contradictionPairs = [
      [/I prefer\s+(.+)/i, /I don't like\s+(.+)/i],
      [/I like\s+(.+)/i, /I hate\s+(.+)/i],
      [/I always\s+(.+)/i, /I never\s+(.+)/i],
    ];

    for (const existing of existingKnowledge) {
      for (const [patternA, patternB] of contradictionPairs) {
        const newMatchA = newContent.match(patternA);
        const existMatchB = existing.content.match(patternB);
        if (newMatchA && existMatchB) {
          // Check if they're about the same subject
          const newSubject = newMatchA[1].toLowerCase().trim();
          const existSubject = existMatchB[1].toLowerCase().trim();
          if (this.subjectsOverlap(newSubject, existSubject)) {
            return existing.id ?? null;
          }
        }

        const newMatchB = newContent.match(patternB);
        const existMatchA = existing.content.match(patternA);
        if (newMatchB && existMatchA) {
          const newSubject = newMatchB[1].toLowerCase().trim();
          const existSubject = existMatchA[1].toLowerCase().trim();
          if (this.subjectsOverlap(newSubject, existSubject)) {
            return existing.id ?? null;
          }
        }
      }
    }

    return null;
  }

  private subjectsOverlap(a: string, b: string): boolean {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }
    return overlap / Math.max(wordsA.size, wordsB.size) > 0.5;
  }

  /** Reset pattern tracking (for testing) */
  reset(): void {
    this.patternCounts.clear();
  }
}
