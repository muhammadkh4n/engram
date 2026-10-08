import { cutWholeChars, tailWholeChars } from '../text/cut-text.js'

/**
 * Upper bound, in UTF-16 code units, on the text sent to the embedding model
 * for one message. When a message is longer, its head is kept: the opening of
 * a message carries its topic.
 */
export const EMBED_MAX_CHARS = 6000

/**
 * Upper bound on the UTF-8 size of that text. text-embedding-3 accepts 8,191
 * tokens, and a byte-level BPE token covers at least one UTF-8 byte, so text
 * of at most 8,191 bytes can never exceed the limit. 6,000 code units alone
 * do not guarantee it: CJK takes 3 bytes per code unit and rare characters
 * can tokenize byte by byte, up to 18,000 tokens.
 */
export const EMBED_MAX_UTF8_BYTES = 8191

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * The head of `text` that the embedding model can always take: at most
 * EMBED_MAX_CHARS code units and EMBED_MAX_UTF8_BYTES bytes of UTF-8, cut on
 * a character boundary. Text within both bounds is returned unchanged.
 */
export function capEmbedText(text: string): string {
  const head = cutWholeChars(text, EMBED_MAX_CHARS)
  // One UTF-16 code unit encodes to at most 3 UTF-8 bytes.
  if (head.length * 3 <= EMBED_MAX_UTF8_BYTES) return head
  const bytes = utf8Encoder.encode(head)
  if (bytes.length <= EMBED_MAX_UTF8_BYTES) return head
  let end = EMBED_MAX_UTF8_BYTES
  // A continuation byte (10xxxxxx) at the cut means a character straddles it.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return utf8Decoder.decode(bytes.subarray(0, end))
}

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
 * EMBED_MAX_CHARS, then at EMBED_MAX_UTF8_BYTES (capEmbedText):
 *  - with a preamble: preamble, blank line, message; cut from the end;
 *  - with neighbour turns (message > 20 chars): the last
 *    EMBED_CONTEXT_MAX_CHARS of the context, a newline, then the whole
 *    message — the context shrinks to fit, and when the message alone fills
 *    the cap the context is dropped and the message head is kept;
 *  - a message > 20 chars on its own: the message head;
 *  - a short message: the raw string content when there is one (too little
 *    clean text to embed meaningfully), else the clean text.
 * Every cut keeps whole characters: a split surrogate pair is malformed
 * text to the embedding provider.
 */
export function buildTextToEmbed(input: EmbedTextInput): string {
  return capEmbedText(buildUncapped(input))
}

function buildUncapped(input: EmbedTextInput): string {
  const { cleanText, rawContent, preamble, contextTurns } = input

  if (preamble) {
    return cutWholeChars(`${preamble.trim()}\n\n${cleanText}`, EMBED_MAX_CHARS)
  }

  if (cleanText.length > 20) {
    if (contextTurns && contextTurns.length > 0) {
      const room = EMBED_MAX_CHARS - cleanText.length - 1
      if (room <= 0) {
        return cutWholeChars(cleanText, EMBED_MAX_CHARS)
      }
      const contextBudget = Math.min(EMBED_CONTEXT_MAX_CHARS, room)
      const context = tailWholeChars(contextTurns.join('\n'), contextBudget)
      return `${context}\n${cleanText}`
    }
    return cutWholeChars(cleanText, EMBED_MAX_CHARS)
  }

  return cutWholeChars(rawContent ?? cleanText, EMBED_MAX_CHARS)
}
