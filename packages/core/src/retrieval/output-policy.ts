import { estimateTokens } from '../utils/tokens.js'

// ---------------------------------------------------------------------------
// Recall payload: rendered sections in, bounded text out
// ---------------------------------------------------------------------------

export type PayloadSection = 'recalled' | 'related' | 'domain' | 'context' | 'faint'

/** Assembly order of the sections. */
export const PAYLOAD_SECTION_ORDER: readonly PayloadSection[] = ['recalled', 'related', 'domain', 'context', 'faint']

/** Opening lines of every non-empty payload. Joined with '\n'; the empty last
 *  entry leaves a blank line before the first section heading. */
export const PAYLOAD_HEADER_LINES: readonly string[] = [
  '## Engram — Recalled Conversation Memory',
  '',
  'IMPORTANT: The following are memories retrieved from past conversations. If the answer to the user\'s question is found below, USE IT directly. Do not say "I don\'t have this information" if it appears here.',
  'Context tags (type, role, device, date) are for your reference — do not include them in responses unless the user asks about when/where/who.',
  '',
]

/** Heading entry of each section. Every entry, heading or item, is joined to
 *  the text before it with '\n', so the embedded newlines produce the blank
 *  lines around each heading. */
export const PAYLOAD_SECTION_HEADERS: Readonly<Record<PayloadSection, string>> = {
  recalled: '### Recalled Memories\n',
  related: '\n### Related Memories\n',
  domain: '\n### Knowledge Domain Context\n',
  context: '\n### Context\n',
  faint: '\n### Faint Associations\n',
}

export interface RenderedItem {
  /** One payload line, e.g. `- [episode · user · 2026-03-04] content`. */
  text: string
  /** The memory id when the item renders a memory. */
  id?: string
}

/** Item lines per section, in rank order. A section with no items is empty. */
export type RenderedPayload = Readonly<Record<PayloadSection, readonly RenderedItem[]>>

export interface RecallOutputPolicy {
  /** Emit only the first `emitK` Recalled items. */
  emitK?: number
  /** Cap on `estimateTokens` of the whole text, headers included. */
  tokenBudget?: number
  /** Emit the Faint Associations section. */
  faint: boolean
}

/** The policy that reproduces the unbounded payload. */
export const DEFAULT_RECALL_OUTPUT_POLICY: RecallOutputPolicy = { faint: true }

export interface PayloadItem {
  section: PayloadSection
  /** The memory id when the item renders a memory. */
  id?: string
  /** `formatted.slice(start, end)` is the item line. */
  start: number
  end: number
}

export interface RecallPayload {
  emittedMemories: number
  emittedAssociations: number
  emittedFaint: number
  /** The token budget stopped assembly before every candidate item was
   *  emitted. Items left out by `emitK` or the faint switch do not count. */
  truncated: boolean
  items: PayloadItem[]
}

export interface AssembledPayload {
  text: string
  payload: RecallPayload
}

export function emptyRecallPayload(): RecallPayload {
  return { emittedMemories: 0, emittedAssociations: 0, emittedFaint: 0, truncated: false, items: [] }
}

function candidatesFor(
  rendered: RenderedPayload,
  section: PayloadSection,
  policy: RecallOutputPolicy,
): readonly RenderedItem[] {
  const items = rendered[section]
  if (section === 'faint' && !policy.faint) return []
  if (section === 'recalled' && policy.emitK !== undefined) return items.slice(0, policy.emitK)
  return items
}

/**
 * Build the payload text from rendered sections under a policy.
 *
 * Prefix rule: assembly stops at the first item that would push the text over
 * the budget; later items and sections are not tried, so a smaller item never
 * jumps a larger, better-ranked one. The first item is always emitted whole so
 * a non-empty recall never returns headers alone. A section heading is written
 * only together with its first emitted item. No emitted item yields ''.
 */
export function assemble(
  rendered: RenderedPayload,
  policy: RecallOutputPolicy = DEFAULT_RECALL_OUTPUT_POLICY,
): AssembledPayload {
  const payload = emptyRecallPayload()
  let text = PAYLOAD_HEADER_LINES.join('\n')

  for (const section of PAYLOAD_SECTION_ORDER) {
    let headed = false
    for (const item of candidatesFor(rendered, section, policy)) {
      const prefix = `${text}${headed ? '' : `\n${PAYLOAD_SECTION_HEADERS[section]}`}\n`
      const next = `${prefix}${item.text}`
      const fits = policy.tokenBudget === undefined || estimateTokens(next) <= policy.tokenBudget
      if (!fits && payload.items.length > 0) {
        payload.truncated = true
        return { text, payload }
      }
      payload.items.push({
        section,
        ...(item.id !== undefined ? { id: item.id } : {}),
        start: prefix.length,
        end: next.length,
      })
      if (section === 'recalled') payload.emittedMemories++
      else if (section === 'related') payload.emittedAssociations++
      else if (section === 'faint') payload.emittedFaint++
      text = next
      headed = true
    }
  }

  return payload.items.length === 0 ? { text: '', payload } : { text, payload }
}

// ---------------------------------------------------------------------------
// Policy from the environment
// ---------------------------------------------------------------------------

const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/

function positiveIntegerFromEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = raw.trim()
  if (!POSITIVE_INTEGER_RE.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`)
  }
  return Number(value)
}

function faintFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env['ENGRAM_RECALL_FAINT']
  if (raw === undefined || raw.trim() === '') return true
  const value = raw.trim()
  if (value === 'on') return true
  if (value === 'off') return false
  throw new Error(`ENGRAM_RECALL_FAINT must be "on" or "off", got "${raw}"`)
}

/**
 * Read ENGRAM_RECALL_EMIT_K, ENGRAM_RECALL_TOKEN_BUDGET (positive integers)
 * and ENGRAM_RECALL_FAINT (on|off, default on). Unset or empty means no
 * limit; any other value throws, naming the variable.
 */
export function recallOutputPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RecallOutputPolicy {
  const emitK = positiveIntegerFromEnv(env, 'ENGRAM_RECALL_EMIT_K')
  const tokenBudget = positiveIntegerFromEnv(env, 'ENGRAM_RECALL_TOKEN_BUDGET')
  return {
    ...(emitK !== undefined ? { emitK } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    faint: faintFromEnv(env),
  }
}

/** The env policy with a per-call token budget taking precedence. */
export function resolveRecallOutputPolicy(env: NodeJS.ProcessEnv, tokenBudget?: number): RecallOutputPolicy {
  const fromEnv = recallOutputPolicyFromEnv(env)
  if (tokenBudget === undefined) return fromEnv
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) {
    throw new RangeError(`tokenBudget must be a positive integer, got ${tokenBudget}`)
  }
  return { ...fromEnv, tokenBudget }
}
