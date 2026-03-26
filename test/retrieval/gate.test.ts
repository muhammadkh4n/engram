import { describe, it, expect } from 'vitest';
import { RetrievalGate } from '../../src/retrieval/gate.js';
import type { SearchResult, Episode } from '../../src/types.js';

function makeResult(content: string, similarity: number): SearchResult<Episode> {
  return {
    item: {
      id: `id-${content}`,
      session_id: 'sess-1',
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    },
    similarity,
  };
}

describe('RetrievalGate', () => {
  describe('default options', () => {
    const gate = new RetrievalGate();
    it('has default minScore of 0.3', () => { expect(gate.getMinScore()).toBe(0.3); });
    it('has default maxResults of 10', () => { expect(gate.getMaxResults()).toBe(10); });
  });

  describe('filtering by score', () => {
    const gate = new RetrievalGate({ minScore: 0.5 });

    it('filters out results below minScore', () => {
      const results = [makeResult('high', 0.9), makeResult('mid', 0.6), makeResult('low', 0.3), makeResult('very low', 0.1)];
      const { results: filtered } = gate.filter(results, 'episode');
      expect(filtered).toHaveLength(2);
      expect(filtered.map((r) => r.item.content)).toEqual(['high', 'mid']);
    });

    it('includes results exactly at minScore', () => {
      const { results: filtered } = gate.filter([makeResult('exact', 0.5)], 'episode');
      expect(filtered).toHaveLength(1);
    });

    it('returns empty array when all below threshold', () => {
      const { results: filtered } = gate.filter([makeResult('low1', 0.1), makeResult('low2', 0.2)], 'episode');
      expect(filtered).toHaveLength(0);
    });
  });

  describe('capping results', () => {
    const gate = new RetrievalGate({ minScore: 0, maxResults: 3 });

    it('caps results at maxResults', () => {
      const results = Array.from({ length: 10 }, (_, i) => makeResult(`item-${i}`, 0.5 + i * 0.05));
      const { results: filtered } = gate.filter(results, 'episode');
      expect(filtered).toHaveLength(3);
    });

    it('returns top results by similarity', () => {
      const results = [makeResult('low', 0.3), makeResult('high', 0.9), makeResult('mid', 0.6), makeResult('highest', 0.95)];
      const { results: filtered } = gate.filter(results, 'episode');
      expect(filtered[0].item.content).toBe('highest');
      expect(filtered[1].item.content).toBe('high');
      expect(filtered[2].item.content).toBe('mid');
    });
  });

  describe('sorting', () => {
    const gate = new RetrievalGate({ minScore: 0 });
    it('sorts results by descending similarity', () => {
      const results = [makeResult('c', 0.3), makeResult('a', 0.9), makeResult('b', 0.6)];
      const { results: sorted } = gate.filter(results, 'episode');
      expect(sorted.map((r) => r.similarity)).toEqual([0.9, 0.6, 0.3]);
    });
  });

  describe('filtered count', () => {
    it('reports correct filtered count', () => {
      const gate = new RetrievalGate({ minScore: 0.5, maxResults: 2 });
      const results = [makeResult('a', 0.9), makeResult('b', 0.8), makeResult('c', 0.7), makeResult('d', 0.3)];
      const gateResult = gate.filter(results, 'episode');
      expect(gateResult.filtered).toBe(2);
    });

    it('reports zero filtered when all pass', () => {
      const gate = new RetrievalGate({ minScore: 0, maxResults: 100 });
      const gateResult = gate.filter([makeResult('a', 0.5), makeResult('b', 0.6)], 'episode');
      expect(gateResult.filtered).toBe(0);
    });
  });

  describe('tier labeling', () => {
    const gate = new RetrievalGate();
    it('labels result with episode tier', () => { expect(gate.filter([], 'episode').tier).toBe('episode'); });
    it('labels result with digest tier', () => { expect(gate.filter([], 'digest').tier).toBe('digest'); });
    it('labels result with knowledge tier', () => { expect(gate.filter([], 'knowledge').tier).toBe('knowledge'); });
  });

  describe('edge cases', () => {
    it('handles empty input', () => {
      const gate = new RetrievalGate();
      const { results, filtered } = gate.filter([], 'episode');
      expect(results).toHaveLength(0);
      expect(filtered).toBe(0);
    });

    it('handles single result above threshold', () => {
      const gate = new RetrievalGate({ minScore: 0.5 });
      const { results: filtered } = gate.filter([makeResult('solo', 0.8)], 'episode');
      expect(filtered).toHaveLength(1);
    });

    it('handles single result below threshold', () => {
      const gate = new RetrievalGate({ minScore: 0.5 });
      const { results: filtered } = gate.filter([makeResult('solo', 0.2)], 'episode');
      expect(filtered).toHaveLength(0);
    });

    it('handles custom options override', () => {
      const gate = new RetrievalGate({ minScore: 0.8, maxResults: 1 });
      expect(gate.getMinScore()).toBe(0.8);
      expect(gate.getMaxResults()).toBe(1);
    });

    it('handles all results with same similarity', () => {
      const gate = new RetrievalGate({ minScore: 0, maxResults: 2 });
      const results = [makeResult('a', 0.5), makeResult('b', 0.5), makeResult('c', 0.5)];
      const { results: filtered } = gate.filter(results, 'episode');
      expect(filtered).toHaveLength(2);
    });
  });
});
