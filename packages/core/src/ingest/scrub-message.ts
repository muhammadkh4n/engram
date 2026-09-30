/**
 * Applies scrubSecrets to everything a message carries into storage or to a
 * model: its content (plain text or content-block arrays, including tool
 * inputs) and every string inside its metadata. Content blocks, tool inputs
 * and metadata are structured data, so here an object key's name decides
 * whether the value under it is a credential.
 */

import type { Message } from '../types.js'
import { placeholder } from './placeholder.js'
import { scrubSecrets } from './scrub-secrets.js'
import type { SecretRedaction } from './scrub-secrets.js'
import { isSecretUnderKey } from './structured-text.js'

export interface ScrubbedMessage {
  message: Message
  redactions: SecretRedaction[]
}

// Content blocks and metadata are JSON-shaped; the bound only protects
// against pathological or cyclic input reaching the walker. Whatever lies
// deeper is replaced unread rather than stored unscrubbed.
const MAX_DEPTH = 32
const DEPTH_LIMIT_KIND = 'depth-limit'

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
 * In `{ password: '…' }` the object key decides: a string or number under a
 * secret-named key is a literal and is replaced whole, whatever characters it
 * holds. Other values are scrubbed as usual.
 */
async function scrubKeyedValue(key: string, value: unknown, redactions: SecretRedaction[], depth: number): Promise<unknown> {
  const literal = typeof value === 'number' ? String(value) : value
  if (typeof literal === 'string' && isSecretUnderKey(key, literal)) {
    redactions.push({ kind: 'named-secret', name: key })
    return placeholder(key)
  }
  return scrubValue(value, redactions, depth + 1)
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
    const scrubbed = await scrubKeyedValue(key, item, redactions, depth)
    if (scrubbed !== item) changed = true
    out[key] = scrubbed
  }
  return changed ? out : value
}

async function scrubValue(value: unknown, redactions: SecretRedaction[], depth: number): Promise<unknown> {
  if (typeof value === 'string') return scrubText(value, redactions)
  const isContainer = Array.isArray(value) || isPlainObject(value)
  if (isContainer && depth >= MAX_DEPTH) {
    redactions.push({ kind: DEPTH_LIMIT_KIND })
    return placeholder(DEPTH_LIMIT_KIND)
  }
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
