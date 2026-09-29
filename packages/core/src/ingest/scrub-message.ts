/**
 * Applies scrubSecrets to everything a message carries into storage or to a
 * model: its content (plain text or content-block arrays, including tool
 * inputs) and every string inside its metadata.
 */

import type { Message } from '../types.js'
import { scrubSecrets } from './scrub-secrets.js'
import type { SecretRedaction } from './scrub-secrets.js'

export interface ScrubbedMessage {
  message: Message
  redactions: SecretRedaction[]
}

// Content blocks and metadata are JSON-shaped; the bound only protects
// against pathological or cyclic input reaching the walker.
const MAX_DEPTH = 32

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function scrubText(text: string, redactions: SecretRedaction[]): string {
  const result = scrubSecrets(text)
  if (result.redactions.length === 0) return text
  redactions.push(...result.redactions)
  return result.text
}

/**
 * A structured `{ password: "hunter2hunter2" }` carries no `NAME=` shape inside
 * the value itself, so the key is judged the same way the scrubber judges a
 * JSON pair in text. Values the scrubber would keep under that key (literals,
 * `$VAR` references, constants) are kept here too.
 */
function scrubKeyedText(key: string, value: string, redactions: SecretRedaction[]): string {
  if (!value.includes('"') && !value.includes('\n')) {
    const asPair = scrubSecrets(`"${key}": "${value}"`)
    const named = asPair.redactions.find((r) => r.kind === 'named-secret' && r.name === key)
    if (named) {
      redactions.push(named)
      return `[REDACTED:${key}]`
    }
  }
  return scrubText(value, redactions)
}

function scrubValue(value: unknown, redactions: SecretRedaction[], depth: number): unknown {
  if (typeof value === 'string') return scrubText(value, redactions)
  if (depth >= MAX_DEPTH) return value

  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const scrubbed = scrubValue(item, redactions, depth + 1)
      if (scrubbed !== item) changed = true
      return scrubbed
    })
    return changed ? out : value
  }

  if (isPlainObject(value)) {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const scrubbed = typeof item === 'string'
        ? scrubKeyedText(key, item, redactions)
        : scrubValue(item, redactions, depth + 1)
      if (scrubbed !== item) changed = true
      out[key] = scrubbed
    }
    return changed ? out : value
  }

  return value
}

/**
 * Returns the message with credential values redacted. When nothing was
 * redacted the original message object is returned unchanged.
 */
export function scrubMessage(message: Message): ScrubbedMessage {
  const redactions: SecretRedaction[] = []
  const content = scrubValue(message.content, redactions, 0) as Message['content']
  const metadata = message.metadata === undefined
    ? undefined
    : (scrubValue(message.metadata, redactions, 0) as Record<string, unknown>)

  if (redactions.length === 0) return { message, redactions }
  return {
    message: { ...message, content, ...(metadata !== undefined ? { metadata } : {}) },
    redactions,
  }
}

/**
 * Log-safe summary: the count and the kinds only, never a value. Key names
 * are left out as well so a log line cannot pair a name with anything.
 */
export function describeRedactions(redactions: readonly SecretRedaction[]): string {
  const counts = new Map<string, number>()
  for (const r of redactions) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1)
  const kinds = [...counts].map(([kind, n]) => `${kind}(${n})`).join(', ')
  return `redacted ${redactions.length} secret value(s): ${kinds}`
}
