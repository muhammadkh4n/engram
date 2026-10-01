/**
 * Reads the recent conversation out of a Claude Code JSONL transcript for the
 * session-summary and pre-compact digests.
 *
 * Claude Code writes one JSON object per line. Conversation turns are
 * `type: "user"` and `type: "assistant"` entries whose `message.content` is a
 * string or an array of blocks. Everything else (attachments, summaries,
 * system lines) is skipped, and so are tool calls and tool results: a user
 * entry that only carries tool results has no text and contributes no turn.
 */

import { readFileSync } from 'node:fs'

export interface ExcerptOptions {
  /** Upper bound on the turn text kept, newest turns first. */
  maxChars: number
  /** Each turn is cut to this many characters. */
  perTurnChars: number
}

export interface TranscriptExcerpt {
  /** `User: …` / `Assistant: …` turns in chronological order, blank-line separated. */
  text: string
  turns: number
  /** The uuid of the newest turn kept, when the transcript records one. */
  lastUuid?: string
}

type TurnType = 'user' | 'assistant'

const ROLE_LABEL: Record<TurnType, string> = { user: 'User', assistant: 'Assistant' }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => {
      const block = b as { type?: unknown; text?: unknown } | null
      return block?.type === 'text' && typeof block.text === 'string'
    })
    .map((b) => b.text)
    .join('\n')
    .trim()
}

interface Turn {
  type: TurnType
  text: string
  uuid?: string
}

function parseTurn(line: string): Turn | null {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const type = entry['type']
  if (type !== 'user' && type !== 'assistant') return null
  // Meta entries are client bookkeeping (command caveats, local command
  // output) injected as user lines, not something the user said.
  if (entry['isMeta'] === true) return null
  const message = entry['message'] as { content?: unknown } | undefined
  const text = textOf(message?.content)
  if (!text) return null
  const uuid = entry['uuid']
  return typeof uuid === 'string' && uuid ? { type, text, uuid } : { type, text }
}

/**
 * Walks the transcript newest first until `maxChars` of turn text are kept,
 * then returns the kept turns oldest first. Throws when the file cannot be
 * read; malformed lines are skipped.
 */
export function readTranscriptExcerpt(path: string, options: ExcerptOptions): TranscriptExcerpt {
  const lines = readFileSync(path, 'utf-8').split('\n')
  const kept: string[] = []
  let lastUuid: string | undefined
  let remaining = options.maxChars

  for (let i = lines.length - 1; i >= 0 && remaining > 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    const turn = parseTurn(line)
    if (!turn) continue
    const text = turn.text.slice(0, Math.min(options.perTurnChars, remaining))
    if (kept.length === 0) lastUuid = turn.uuid
    kept.push(`${ROLE_LABEL[turn.type]}: ${text}`)
    remaining -= text.length
  }

  kept.reverse()
  return { text: kept.join('\n\n'), turns: kept.length, ...(lastUuid ? { lastUuid } : {}) }
}
