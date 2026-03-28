/**
 * Extract searchable content from raw message content.
 * Strips tool calls, meta-queries, system metadata, timestamps,
 * and short acknowledgments. Returns clean text for indexing.
 *
 * This is the LCM-style fix for retrieval pollution: embeddings are computed
 * on cleaned text so that vector search ranks real content above noise like
 * tool invocation commands and system metadata blocks.
 */
export function extractSearchableContent(content: string, role: string): string {
  let text = content

  // Remove timestamps in brackets: [Sat 2026-03-28 05:56 GMT+5]
  text = text.replace(/\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}[^\]]*\]/g, '')

  // Remove tool call markers
  text = text.replace(/\[Tool call: [^\]]+\]\s*/g, '')

  // Remove system metadata blocks: match from the header line through the
  // closing ``` fence. The pattern explicitly matches the opening fence then
  // uses [\s\S]*? to span the body until the closing fence line.
  text = text.replace(/^Conversation info \(untrusted metadata\):.*?\n```[\s\S]*?\n```\s*/m, '')
  text = text.replace(/^System:\s*\[[^\]]*\]\s*/gm, '')

  // Remove "Sender (untrusted metadata):" blocks
  text = text.replace(/^Sender \(untrusted[^)]*\):.*?\n```[\s\S]*?\n```\s*/m, '')

  // For user messages, remove tool invocation commands. Trim first so that a
  // leading space left by timestamp removal does not prevent the ^ anchor match.
  if (role === 'user') {
    text = text.trim()
    text = text.replace(/^(Use|Run|Call|Execute)\s+(the\s+)?engram_\w+\s+(tool\s+)?(to\s+)?/im, '')
  }

  // Clean up extra whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return text
}
