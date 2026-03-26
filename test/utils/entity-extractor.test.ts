import { describe, it, expect } from 'vitest';
import { EntityExtractor } from '../../src/utils/entity-extractor.js';

describe('EntityExtractor', () => {
  const extractor = new EntityExtractor();

  describe('technologies', () => {
    it('should extract programming languages', () => {
      const result = extractor.extract('I am working with TypeScript and Python.');
      expect(result.technologies).toContain('TypeScript');
      expect(result.technologies).toContain('Python');
    });

    it('should extract frameworks and tools', () => {
      const result = extractor.extract('We use React, Next.js, and Supabase.');
      expect(result.technologies).toContain('React');
      expect(result.technologies).toContain('Supabase');
    });

    it('should extract case-insensitively', () => {
      const result = extractor.extract('typescript is great');
      expect(result.technologies.length).toBeGreaterThan(0);
    });

    it('should handle no technologies', () => {
      const result = extractor.extract('Had a nice lunch today.');
      expect(result.technologies).toEqual([]);
    });
  });

  describe('projects', () => {
    it('should extract kebab-case project names', () => {
      const result = extractor.extract('Working on the openclaw-memory project.');
      expect(result.projects).toContain('openclaw-memory');
    });

    it('should extract "working on X" pattern', () => {
      const result = extractor.extract('I am working on openclaw-panel.');
      expect(result.projects.length).toBeGreaterThan(0);
    });
  });

  describe('people', () => {
    it('should extract @mentions', () => {
      const result = extractor.extract('Please ask @Muhammad about this.');
      // The pattern looks for capitalized words after @
      expect(result.people).toContain('Muhammad');
    });

    it('should not extract common words as names', () => {
      const result = extractor.extract('The best way to do this is to try.');
      expect(result.people).toEqual([]);
    });
  });

  describe('extractAsTags', () => {
    it('should return only non-empty categories', () => {
      const tags = extractor.extractAsTags('Using TypeScript for the openclaw-memory project.');
      expect(tags.technologies).toBeDefined();
      expect(tags.projects).toBeDefined();
      // people may or may not be present
    });

    it('should return empty object for no entities', () => {
      const tags = extractor.extractAsTags('hello world');
      expect(Object.keys(tags).length).toBe(0);
    });
  });
});
