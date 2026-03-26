import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeExtractor } from '../../src/tiers/knowledge-extractor.js';
import type { Digest, Knowledge } from '../../src/types.js';

describe('KnowledgeExtractor', () => {
  let extractor: KnowledgeExtractor;

  beforeEach(() => {
    extractor = new KnowledgeExtractor({ batchThreshold: 3, batchWindowDays: 7 });
  });

  describe('extractImmediate', () => {
    it('should extract preferences', () => {
      const digest: Digest = {
        session_id: 's1',
        summary: 'User said I prefer TypeScript over JavaScript.',
        key_topics: ['TypeScript'],
        episode_ids: [],
      };
      const results = extractor.extractImmediate(digest);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].metadata?.category).toBe('preference');
      expect(results[0].confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should extract decisions', () => {
      const digest: Digest = {
        session_id: 's1',
        summary: "They decided to use Supabase for storage.",
        key_topics: ['Supabase'],
        episode_ids: [],
      };
      // "decided to" pattern should trigger -- let's actually look at patterns
      // Pattern: /we decided to\s+(.+?)(?:\.|,|$)/gi
      const digest2: Digest = {
        session_id: 's1',
        summary: "We decided to use Supabase for storage.",
        key_topics: ['Supabase'],
        episode_ids: [],
      };
      const results = extractor.extractImmediate(digest2);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].metadata?.category).toBe('decision');
    });

    it('should extract personal info', () => {
      const digest: Digest = {
        session_id: 's1',
        summary: "User mentioned my name is Muhammad Khan.",
        key_topics: [],
        episode_ids: [],
      };
      const results = extractor.extractImmediate(digest);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].metadata?.category).toBe('personal_info');
    });
  });

  describe('extractFromDigests (batch)', () => {
    it('should promote topics occurring 3+ times', () => {
      const digests: Digest[] = [];
      for (let i = 0; i < 4; i++) {
        digests.push({
          id: `d${i}`,
          session_id: `s${i}`,
          summary: `Session about TypeScript`,
          key_topics: ['typescript'],
          episode_ids: [],
        });
      }

      const results = extractor.extractFromDigests(digests);
      const batchResults = results.filter((r) => r.metadata?.extraction === 'batch');
      expect(batchResults.length).toBeGreaterThan(0);
      expect(batchResults[0].content).toBe('typescript');
    });

    it('should not promote topics below threshold', () => {
      const digests: Digest[] = [
        { id: 'd1', session_id: 's1', summary: 'About React', key_topics: ['react'], episode_ids: [] },
        { id: 'd2', session_id: 's2', summary: 'About React again', key_topics: ['react'], episode_ids: [] },
      ];

      const results = extractor.extractFromDigests(digests);
      const batchResults = results.filter((r) => r.metadata?.extraction === 'batch');
      expect(batchResults.length).toBe(0);
    });
  });

  describe('checkSupersession', () => {
    it('should detect contradicting preferences', () => {
      const existing: Knowledge[] = [{
        id: 'k1',
        topic: 'preference',
        content: 'I like dark mode',
        confidence: 0.9,
        source_digest_ids: [],
      }];

      const result = extractor.checkSupersession('I hate dark mode', existing);
      expect(result).toBe('k1');
    });

    it('should return null for non-contradicting content', () => {
      const existing: Knowledge[] = [{
        id: 'k1',
        topic: 'preference',
        content: 'I like TypeScript',
        confidence: 0.9,
        source_digest_ids: [],
      }];

      const result = extractor.checkSupersession('I prefer Supabase', existing);
      expect(result).toBeNull();
    });
  });
});
