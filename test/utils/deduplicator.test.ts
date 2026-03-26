import { describe, it, expect } from 'vitest';
import { Deduplicator } from '../../src/utils/deduplicator.js';

describe('Deduplicator', () => {
  const dedup = new Deduplicator(0.92);

  describe('cosineSimilarity', () => {
    it('should return 1.0 for identical vectors', () => {
      const v = [1, 2, 3, 4, 5];
      expect(dedup.cosineSimilarity(v, v)).toBeCloseTo(1.0);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(dedup.cosineSimilarity(a, b)).toBeCloseTo(0);
    });

    it('should return -1 for opposite vectors', () => {
      const a = [1, 0, 0];
      const b = [-1, 0, 0];
      expect(dedup.cosineSimilarity(a, b)).toBeCloseTo(-1);
    });

    it('should handle zero vectors', () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      expect(dedup.cosineSimilarity(a, b)).toBe(0);
    });

    it('should handle different length vectors', () => {
      const a = [1, 2];
      const b = [1, 2, 3];
      expect(dedup.cosineSimilarity(a, b)).toBe(0);
    });
  });

  describe('checkDuplicate', () => {
    it('should detect duplicates above threshold', () => {
      const newEmbedding = [1, 2, 3, 4, 5];
      const existing = [
        { id: 'k1', embedding: [1, 2, 3, 4, 5] }, // identical
      ];
      const result = dedup.checkDuplicate(newEmbedding, existing);
      expect(result.isDuplicate).toBe(true);
      expect(result.existingId).toBe('k1');
      expect(result.similarity).toBeCloseTo(1.0);
    });

    it('should not flag non-duplicates', () => {
      const newEmbedding = [1, 0, 0, 0, 0];
      const existing = [
        { id: 'k1', embedding: [0, 0, 0, 0, 1] }, // orthogonal
      ];
      const result = dedup.checkDuplicate(newEmbedding, existing);
      expect(result.isDuplicate).toBe(false);
    });

    it('should find the best match among multiple candidates', () => {
      const newEmbedding = [1, 2, 3, 4, 5];
      const existing = [
        { id: 'k1', embedding: [1, 2, 3, 4, 4.9] }, // very similar
        { id: 'k2', embedding: [1, 2, 3, 4, 5] },   // identical
        { id: 'k3', embedding: [0, 0, 0, 0, 1] },   // different
      ];
      const result = dedup.checkDuplicate(newEmbedding, existing);
      expect(result.isDuplicate).toBe(true);
      expect(result.existingId).toBe('k2');
    });

    it('should handle empty existing set', () => {
      const result = dedup.checkDuplicate([1, 2, 3], []);
      expect(result.isDuplicate).toBe(false);
    });
  });

  it('should expose threshold', () => {
    expect(dedup.getThreshold()).toBe(0.92);
  });
});
