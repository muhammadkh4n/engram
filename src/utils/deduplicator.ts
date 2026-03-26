import type { Knowledge } from '../types.js';
import type { EmbeddingService } from './embeddings.js';

export interface DeduplicationResult {
  isDuplicate: boolean;
  /** If duplicate, the ID of the existing knowledge entry */
  existingId?: string;
  /** Cosine similarity score with existing entry */
  similarity?: number;
}

/**
 * Semantic Deduplication.
 *
 * Before inserting knowledge, checks cosine similarity against existing knowledge.
 * If similarity > threshold (default 0.92), updates occurrence_count instead of inserting.
 */
export class Deduplicator {
  private threshold: number;

  constructor(threshold = 0.92) {
    this.threshold = threshold;
  }

  /**
   * Check if new content is semantically duplicate of any existing knowledge.
   */
  checkDuplicate(
    newEmbedding: number[],
    existingKnowledge: Array<{ id: string; embedding: number[] }>
  ): DeduplicationResult {
    let bestMatch: { id: string; similarity: number } | null = null;

    for (const existing of existingKnowledge) {
      const similarity = this.cosineSimilarity(newEmbedding, existing.embedding);
      if (similarity > this.threshold) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { id: existing.id, similarity };
        }
      }
    }

    if (bestMatch) {
      return {
        isDuplicate: true,
        existingId: bestMatch.id,
        similarity: bestMatch.similarity,
      };
    }

    return { isDuplicate: false };
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  /** Get the current threshold */
  getThreshold(): number {
    return this.threshold;
  }
}
