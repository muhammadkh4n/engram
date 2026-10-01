import { OpenAIEmbeddingService } from '@engram-mem/openai'

/**
 * The width the OpenAI embedder builds vectors at: the requested one, else the
 * service's own default. Read from a service instance so the run record cannot
 * drift from the width actually sent with every request. Constructing the
 * service makes no network call; the key is never used.
 */
export function openaiEmbedDims(requested?: number): number {
  if (requested !== undefined) return requested
  return new OpenAIEmbeddingService({ apiKey: 'unused' }).dimensions()
}
