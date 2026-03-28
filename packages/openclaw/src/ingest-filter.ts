/**
 * Ingestion filter: decides whether a message should be stored in memory.
 *
 * Prevents "ingestion pollution" — tool invocation commands like
 * "Use engram_search to find X" contain search terms verbatim, so they
 * outscore real content in vector search. This filter drops them before
 * they reach the memory store.
 */

/**
 * Return true when the message content is worth storing in long-term memory.
 * Return false to skip ingestion for meta-commands and noise.
 */
export function shouldIngest(content: string, role: string): boolean {
  const trimmed = content.trim()

  // Skip very short messages
  if (trimmed.length < 10) return false

  // Skip system metadata
  if (trimmed.startsWith('Conversation info')) return false
  if (trimmed.startsWith('System:') && trimmed.length < 200) return false

  // Skip user messages that are just tool invocation commands
  if (role === 'user') {
    if (/^(use|run|call|execute)\s+engram_/i.test(trimmed)) return false
    if (/^(use|run)\s+the\s+engram/i.test(trimmed)) return false
  }

  // Skip assistant messages that are ONLY tool calls with no useful text
  if (role === 'assistant') {
    const withoutToolCalls = trimmed.replace(/\[Tool call: [^\]]+\]\s*/g, '').trim()
    if (withoutToolCalls.length < 20) return false
  }

  return true
}
