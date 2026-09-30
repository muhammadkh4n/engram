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

async function scrubText(text: string, redactions: SecretRedaction[]): Promise<string> {
  const result = await scrubSecrets(text)
  if (result.redactions.length === 0) return text
  redactions.push(...result.redactions)
  return result.text
}

/**
 * A structured `{ password: "hunter2hunter2" }` carries no `NAME=` shape inside
 * the value itself, so the key is judged the same way the scrubber judges a
 * JSON pair in text. Values the scrubber would keep under that key (empty,
 * booleans, `$VAR` references, keys naming a variable) are kept here too.
 */
async function scrubKeyedText(key: string, value: string, redactions: SecretRedaction[]): Promise<string> {
  if (!value.includes('"') && !value.includes('\n')) {
    const asPair = await scrubSecrets(`"${key}": "${value}"`)
    const named = asPair.redactions.find((r) => r.kind === 'named-secret' && r.name === key)
    if (named) {
      redactions.push(named)
      return `[REDACTED:${key}]`
    }
  }
  return scrubText(value, redactions)
}

async function scrubArray(value: unknown[], redactions: SecretRedaction[], depth: number): Promise<unknown[]> {
  let changed = false
  const out: unknown[] = []
  for (const item of value) {
    const scrubbed = await scrubValue(item, redactions, depth + 1)
    if (scrubbed !== item) changed = true
    out.push(scrubbed)
  }
  return changed ? out : value
}

async function scrubObject(
  value: Record<string, unknown>,
  redactions: SecretRedaction[],
  depth: number,
): Promise<Record<string, unknown>> {
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const scrubbed = typeof item === 'string'
      ? await scrubKeyedText(key, item, redactions)
      : await scrubValue(item, redactions, depth + 1)
    if (scrubbed !== item) changed = true
    out[key] = scrubbed
  }
  return changed ? out : value
}

async function scrubValue(value: unknown, redactions: SecretRedaction[], depth: number): Promise<unknown> {
  if (typeof value === 'string') return scrubText(value, redactions)
  if (depth >= MAX_DEPTH) return value
  if (Array.isArray(value)) return scrubArray(value, redactions, depth)
  if (isPlainObject(value)) return scrubObject(value, redactions, depth)
  return value
}

/**
 * Returns the message with credential values redacted. When nothing was
 * redacted the original message object is returned unchanged.
 */
export async function scrubMessage(message: Message): Promise<ScrubbedMessage> {
  const redactions: SecretRedaction[] = []
  const content = (await scrubValue(message.content, redactions, 0)) as Message['content']
  const metadata = message.metadata === undefined
    ? undefined
    : ((await scrubValue(message.metadata, redactions, 0)) as Record<string, unknown>)

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
