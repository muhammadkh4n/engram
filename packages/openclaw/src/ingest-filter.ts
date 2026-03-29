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

  // --- Length gate ---
  if (trimmed.length < 15) return false

  // --- System / metadata noise ---
  // These checks are defense-in-depth — extractTextForQuery already strips
  // OpenClaw headers. The length guard prevents blocking substantive messages
  // that happen to start with a metadata prefix.
  if (trimmed.startsWith('Conversation info') && trimmed.length < 300) return false
  if (trimmed.startsWith('Sender (untrusted') && trimmed.length < 100) return false
  if (/^System:\s*\[/.test(trimmed) && trimmed.length < 300) return false

  // --- Heartbeat / cron prompts ---
  if (/HEARTBEAT_OK/i.test(trimmed)) return false
  if (/Read HEARTBEAT\.md/i.test(trimmed)) return false
  if (/^Read \w+\.md if it exists/i.test(trimmed)) return false

  // --- User tool invocation commands ---
  if (role === 'user') {
    if (/^(use|run|call|execute)\s+(the\s+)?engram_/i.test(trimmed)) return false
    if (/^(use|run)\s+the\s+engram/i.test(trimmed)) return false
  }

  // --- Assistant messages that are ONLY tool calls ---
  if (role === 'assistant') {
    const withoutToolCalls = trimmed.replace(/\[Tool call: [^\]]+\]\s*/g, '').trim()
    if (withoutToolCalls.length < 30) return false
  }

  // --- WhatsApp/Telegram gateway noise ---
  if (/^System: \[\d{4}-\d{2}-\d{2}.*gateway (dis)?connected/i.test(trimmed)) return false

  // --- Pure acknowledgments ---
  if (/^(ok|okay|sure|yes|no|yep|nope|thanks|thank you|got it|done|lol|haha|hmm|ah|oh)\s*[.!]?$/i.test(trimmed)) return false

  return true
}
