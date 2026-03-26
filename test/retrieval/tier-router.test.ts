import { describe, it, expect } from 'vitest';
import { TierRouter } from '../../src/retrieval/tier-router.js';

describe('TierRouter', () => {
  const router = new TierRouter();

  describe('short queries', () => {
    it('routes very short query to episodes only', () => {
      expect(router.route('hello')).toEqual(['episode']);
    });

    it('routes short query under 20 chars to episodes', () => {
      expect(router.route('what time is it')).toEqual(['episode']);
    });

    it('considers trimmed length', () => {
      expect(router.route('  hi  ')).toEqual(['episode']);
    });
  });

  describe('episode patterns', () => {
    it('routes "just said" to episodes + digests', () => {
      const tiers = router.route('what did they just say about the project');
      expect(tiers).toContain('episode');
      expect(tiers).toContain('digest');
    });

    it('routes "recently" to episodes + digests', () => {
      const tiers = router.route('what was recently discussed about the deployment');
      expect(tiers).toContain('episode');
    });

    it('routes "earlier" to episodes + digests', () => {
      const tiers = router.route('what did I mention earlier about the config');
      expect(tiers).toContain('episode');
    });

    it('routes "this session" to episodes + digests', () => {
      const tiers = router.route('summarize what happened in this session so far please');
      expect(tiers).toContain('episode');
    });

    it('routes "told" to episodes + digests', () => {
      const tiers = router.route('what did the user told me about their setup');
      expect(tiers).toContain('episode');
    });
  });

  describe('knowledge patterns', () => {
    it('routes "what is" to knowledge + digests', () => {
      const tiers = router.route('what is the difference between REST and GraphQL');
      expect(tiers).toContain('knowledge');
      expect(tiers).toContain('digest');
    });

    it('routes "how to" to knowledge + digests', () => {
      expect(router.route('how to configure nginx reverse proxy')).toContain('knowledge');
    });

    it('routes "explain" to knowledge + digests', () => {
      expect(router.route('explain the circuit breaker pattern in detail')).toContain('knowledge');
    });

    it('routes "preference" to knowledge + digests', () => {
      expect(router.route('what is the user preference for code formatting')).toContain('knowledge');
    });

    it('routes "generally" to knowledge + digests', () => {
      expect(router.route('what does the user generally prefer for deployments')).toContain('knowledge');
    });

    it('routes "always" to knowledge + digests', () => {
      expect(router.route('the user always wants tests before merging code')).toContain('knowledge');
    });
  });

  describe('digest patterns', () => {
    it('routes "summary" to include digests', () => {
      expect(router.route('give me a summary of the last few sessions')).toContain('digest');
    });

    it('routes "previous session" to include digests', () => {
      expect(router.route('what happened in the previous session with MK')).toContain('digest');
    });

    it('routes "recap" to include digests', () => {
      expect(router.route('can you recap what we discussed last week')).toContain('digest');
    });

    it('routes "pattern" to include digests', () => {
      expect(router.route('is there a pattern in how the user reports bugs')).toContain('digest');
    });

    it('routes "overview" to include digests', () => {
      expect(router.route('give me an overview of all the project discussions')).toContain('digest');
    });
  });

  describe('mixed patterns', () => {
    it('routes query with both episode and knowledge signals', () => {
      const tiers = router.route('what did they just say about how to configure the server');
      expect(tiers).toContain('episode');
      expect(tiers).toContain('knowledge');
    });

    it('routes query with digest and knowledge signals', () => {
      const tiers = router.route('summarize what is known about the deployment process');
      expect(tiers).toContain('digest');
      expect(tiers).toContain('knowledge');
    });
  });

  describe('long queries', () => {
    it('routes queries over 80 chars to all tiers', () => {
      const longQuery = 'this is a very long query that does not match any specific patterns but is quite detailed and verbose';
      expect(longQuery.length).toBeGreaterThan(80);
      const tiers = router.route(longQuery);
      expect(tiers).toContain('episode');
      expect(tiers).toContain('digest');
      expect(tiers).toContain('knowledge');
    });
  });

  describe('default routing', () => {
    it('routes medium queries without patterns to all tiers', () => {
      const tiers = router.route('something about the project configuration');
      expect(tiers).toContain('episode');
      expect(tiers).toContain('digest');
      expect(tiers).toContain('knowledge');
    });
  });

  describe('edge cases', () => {
    it('routes empty string to all tiers', () => {
      const tiers = router.route('');
      expect(tiers).toContain('episode');
      expect(tiers).toContain('digest');
      expect(tiers).toContain('knowledge');
    });

    it('routes whitespace-only to all tiers', () => {
      const tiers = router.route('   ');
      expect(tiers).toContain('episode');
      expect(tiers).toContain('digest');
      expect(tiers).toContain('knowledge');
    });

    it('is case insensitive', () => {
      expect(router.route('WHAT IS the meaning of life and everything')).toContain('knowledge');
    });

    it('returns arrays (not sets)', () => {
      expect(Array.isArray(router.route('test query for routing'))).toBe(true);
    });

    it('returns no duplicate tiers', () => {
      const tiers = router.route('summarize what was recently discussed about the last session recap');
      const unique = new Set(tiers);
      expect(tiers.length).toBe(unique.size);
    });
  });
});
