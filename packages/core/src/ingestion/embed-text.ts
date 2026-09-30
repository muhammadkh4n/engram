/**
 * Upper bound on the text sent to the embedding model for one message.
 * text-embedding-3 accepts 8,191 tokens; 6,000 characters stays under that
 * even at one token per character (dense code, CJK, base64). When a message
 * is longer, its head is kept: the opening of a message carries its topic.
 */
export const EMBED_MAX_CHARS = 6000

/** Upper bound on the neighbour-turn context prefixed to a message. */
export const EMBED_CONTEXT_MAX_CHARS = 500

/**
 * Version of the embed-text construction rules, stored on each episode as
 * `metadata.embedTextVersion` when a vector is written. Rows embedded under an
 * older rule (tail-kept text, which could drop the preamble and the message
 * head) carry no marker and can be selected for a re-embed.
 */
export const EMBED_TEXT_VERSION = 2

export interface EmbedTextInput {
  /** Message text after parsing (no tool calls, timestamps or markers). */
  readonly cleanText: string
  /** The message's raw content when it was a plain string. */
  readonly rawContent?: string
  /** Situating preamble generated for this message; empty means none. */
  readonly preamble?: string
  /** Preceding turns of the same session, oldest first. */
  readonly contextTurns?: readonly string[]
}

/**
 * Build the text the embedding model sees for one message. ingest() and
 * ingestBatch() and the backfill tools share this function: different rules
 * on different paths would put vectors of the same content in different
 * places of the embedding space.
 *
 * Every rule keeps the head of the text and caps the total at
 * EMBED_MAX_CHARS:
 *  - with a preamble: preamble, blank line, message; cut from the end;
 *  - with neighbour turns (message > 20 chars): the last
 *    EMBED_CONTEXT_MAX_CHARS of the context, a newline, then the whole
 *    message — the context shrinks to fit, and when the message alone fills
 *    the cap the context is dropped and the message head is kept;
 *  - a message > 20 chars on its own: the message head;
 *  - a short message: the raw string content when there is one (too little
 *    clean text to embed meaningfully), else the clean text.
 */
export function buildTextToEmbed(input: EmbedTextInput): string {
  const { cleanText, rawContent, preamble, contextTurns } = input

  if (preamble) {
    return `${preamble.trim()}\n\n${cleanText}`.slice(0, EMBED_MAX_CHARS)
  }

  if (cleanText.length > 20) {
    if (contextTurns && contextTurns.length > 0) {
      const room = EMBED_MAX_CHARS - cleanText.length - 1
      if (room <= 0) {
        return cleanText.slice(0, EMBED_MAX_CHARS)
      }
      const contextBudget = Math.min(EMBED_CONTEXT_MAX_CHARS, room)
      const context = contextTurns.join('\n').slice(-contextBudget)
      return `${context}\n${cleanText}`
    }
    return cleanText.slice(0, EMBED_MAX_CHARS)
  }

  return (rawContent ?? cleanText).slice(0, EMBED_MAX_CHARS)
}
