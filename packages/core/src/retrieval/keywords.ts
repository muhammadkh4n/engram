// Common English stop words to filter out during keyword extraction
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was',
  'this', 'that', 'have', 'with', 'from', 'they', 'been', 'has', 'will',
  'its', 'our', 'let', 'did', 'how', 'what', 'who', 'why', 'when', 'where',
  'a', 'an', 'in', 'on', 'at', 'to', 'is', 'it', 'of', 'or', 'as', 'be',
  'by', 'do', 'if', 'no', 'so', 'up', 'we', 'me', 'my', 'he', 'she', 'his',
  'her', 'we', 'their', 'them', 'than', 'then', 'into', 'over', 'just',
  'also', 'use', 'get', 'got', 'one', 'two', 'now', 'new', 'may', 'any',
])

/** Lowercased alphanumeric tokens of at least 3 characters that are not
 *  stop words. Priming uses it both to choose topics and to match them, so
 *  a topic only ever matches a whole token. */
export function extractKeywords(content: string): string[] {
  return content
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/gi, '').toLowerCase())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
}
