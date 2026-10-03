import type { RecallDegradation } from '../types.js'

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

/** First line of a recall whose query could not be embedded, so only the
 *  lexical leg ran. Tells the reader why results may miss paraphrases. */
export function vectorUnavailableNotice(reason: string): string {
  return `> Semantic search unavailable (${reason}); these results come from keyword search only.`
}

/** First line of a degraded recall. When the keyword search failed as well,
 *  the results come from a plain text match, and the notice names both
 *  failures so an empty or thin answer is not read as authoritative. */
export function degradedRecallNotice(degraded: RecallDegradation): string {
  if (degraded.lexical === undefined) return vectorUnavailableNotice(degraded.vector)
  return `> Semantic and keyword search unavailable (semantic: ${degraded.vector}; keyword: ${degraded.lexical}); these results come from a plain text match only.`
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
  /** Fraction of the budget room held for Related Memories, 0 to
   *  `MAX_RELATED_SHARE`. Applies only with `tokenBudget`; defaults to
   *  `DEFAULT_RELATED_SHARE`. */
  relatedShare?: number
  /** Longest item in tokens; a longer item is cut. Applies only with
   *  `tokenBudget`; defaults to a quarter of the budget. */
  itemMaxTokens?: number
  /** Emit the Faint Associations section. */
  faint: boolean
}

/** The policy that reproduces the unbounded payload. */
export const DEFAULT_RECALL_OUTPUT_POLICY: RecallOutputPolicy = { faint: true }

/** Related Memories' share of the budget room when the policy names none. */
export const DEFAULT_RELATED_SHARE = 0.3

/** Largest Related share, so the ranked section always keeps a tenth of the room. */
export const MAX_RELATED_SHARE = 0.9

/** Appended to an item cut at the item cap. */
export const ITEM_CUT_MARKER = ' …'

/** Smallest pass-1 room, in chars, that Recalled or Related reserves under a
 *  budget. Below it the first item would keep about 60 chars after the
 *  section heading, the cut marker and its `- [episode · user · date]` tag:
 *  a tag and a few words, which tells the reader nothing and costs room the
 *  other section can use. A section with less room reserves nothing and its
 *  room goes to the other section. */
export const MIN_SECTION_ROOM_CHARS = 120

/** `estimateTokens` counts ceil(chars / 4), so a text fits a budget of B
 *  tokens exactly when it has at most 4·B chars. Assembly under a budget
 *  works in chars, where section costs add up exactly. */
const CHARS_PER_TOKEN = 4

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
  /** The token budget changed the payload: assembly left out a candidate
   *  item, or an item was cut at the item cap. Items left out by `emitK` or
   *  the faint switch do not count. */
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

type SectionItems = Record<PayloadSection, readonly RenderedItem[]>

function headerText(notice: string | undefined): string {
  return (notice !== undefined ? [notice, ...PAYLOAD_HEADER_LINES] : PAYLOAD_HEADER_LINES).join('\n')
}

/** Write the header and, per section, its heading and items. Every item is
 *  joined to the text before it with '\n'; a heading is written only with
 *  its section's first item. No item yields ''. */
function writePayload(header: string, sections: SectionItems): AssembledPayload {
  const payload = emptyRecallPayload()
  const parts = [header]
  let length = header.length

  for (const section of PAYLOAD_SECTION_ORDER) {
    sections[section].forEach((item, i) => {
      const lead = i === 0 ? `\n${PAYLOAD_SECTION_HEADERS[section]}\n` : '\n'
      const start = length + lead.length
      parts.push(lead, item.text)
      length = start + item.text.length
      payload.items.push({ section, ...(item.id !== undefined ? { id: item.id } : {}), start, end: length })
      if (section === 'recalled') payload.emittedMemories++
      else if (section === 'related') payload.emittedAssociations++
      else if (section === 'faint') payload.emittedFaint++
    })
  }

  return { text: payload.items.length === 0 ? '' : parts.join(''), payload }
}

/**
 * Cut `text` to at most `maxChars` chars, ending at a word boundary followed
 * by `ITEM_CUT_MARKER`. Text with no word boundary in range is cut hard,
 * never inside a surrogate pair. Text that fits is returned unchanged.
 */
export function capItemChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const room = Math.max(0, maxChars - ITEM_CUT_MARKER.length)
  for (let end = room; end > 0; end--) {
    if (/\s/.test(text[end] ?? '') && !/\s/.test(text[end - 1] ?? '')) return `${text.slice(0, end)}${ITEM_CUT_MARKER}`
  }
  const code = text.charCodeAt(room - 1)
  const end = code >= 0xd800 && code <= 0xdbff ? room - 1 : room
  return `${text.slice(0, end)}${ITEM_CUT_MARKER}`
}

/** `capItemChars` with the limit in tokens. */
export function capItemText(text: string, maxTokens: number): string {
  return capItemChars(text, maxTokens * CHARS_PER_TOKEN)
}

function checkBudgetFields(policy: RecallOutputPolicy): void {
  const { relatedShare, itemMaxTokens } = policy
  if (relatedShare !== undefined && !(relatedShare >= 0 && relatedShare <= MAX_RELATED_SHARE)) {
    throw new RangeError(`relatedShare must be between 0 and ${MAX_RELATED_SHARE}, got ${relatedShare}`)
  }
  if (itemMaxTokens !== undefined && !(Number.isSafeInteger(itemMaxTokens) && itemMaxTokens >= 1)) {
    throw new RangeError(`itemMaxTokens must be a positive integer, got ${itemMaxTokens}`)
  }
}

/** Char cost of each item when emitted after the ones before it: the joining
 *  '\n' and the item, plus the section heading for the first. */
function itemCosts(section: PayloadSection, items: readonly RenderedItem[]): number[] {
  return items.map((item, i) => (i === 0 ? 1 + PAYLOAD_SECTION_HEADERS[section].length : 0) + 1 + item.text.length)
}

/** How many items after the first `from` fit in `room` chars, and their cost. */
function extendPrefix(costs: readonly number[], from: number, room: number): { count: number; used: number } {
  let used = 0
  let count = from
  while (count < costs.length && used + (costs[count] ?? 0) <= room) used += costs[count++] ?? 0
  return { count, used }
}

interface PassOneRooms {
  recalled: number
  related: number
}

/**
 * Pass-1 room of Recalled and Related, in chars: Related holds
 * `room · share` and Recalled the rest. A section with no candidates reserves
 * nothing, and neither does one whose room is below `MIN_SECTION_ROOM_CHARS`;
 * the other section then holds the whole room.
 */
function passOneRooms(room: number, share: number, hasRecalled: boolean, hasRelated: boolean): PassOneRooms {
  const atLeastFloor = (chars: number) => (chars >= MIN_SECTION_ROOM_CHARS ? chars : 0)
  if (!hasRelated) return { recalled: hasRecalled ? atLeastFloor(room) : 0, related: 0 }
  if (!hasRecalled) return { recalled: 0, related: atLeastFloor(room) }
  const related = Math.floor(room * share)
  if (related < MIN_SECTION_ROOM_CHARS) return { recalled: atLeastFloor(room), related: 0 }
  if (room - related < MIN_SECTION_ROOM_CHARS) return { recalled: 0, related: room }
  return { recalled: room - related, related }
}

/** Longest first item, in chars, that fits a section with `sectionRoom`
 *  chars: the room minus the heading and the two joining newlines, and never
 *  more than the item cap. */
function firstItemChars(section: PayloadSection, sectionRoom: number, itemMaxTokens: number): number {
  return Math.min(itemMaxTokens * CHARS_PER_TOKEN, sectionRoom - PAYLOAD_SECTION_HEADERS[section].length - 2)
}

/**
 * Budgeted assembly, all in chars. The room R is the budget minus the header
 * and notice. Every item is first cut to the item cap, which never exceeds
 * the budget. Pass 1: Recalled and Related each take the prefix that fits in
 * their room (see `passOneRooms`), and the first item of a section with room
 * is cut to fit it, so every section that holds room shows its first memory
 * whatever the item cap and the share. Pass 2: room either one left unused
 * goes to the other, Recalled first. Domain, Context and Faint then fill what
 * is left in order; the first of their items that does not fit ends assembly.
 */
function assembleWithinBudget(
  rendered: RenderedPayload,
  policy: RecallOutputPolicy,
  tokenBudget: number,
  notice: string | undefined,
): AssembledPayload {
  checkBudgetFields(policy)
  const itemMaxTokens = Math.min(policy.itemMaxTokens ?? Math.max(1, Math.floor(tokenBudget / 4)), tokenBudget)
  const header = headerText(notice)
  const room = Math.max(0, tokenBudget * CHARS_PER_TOKEN - header.length)

  const originals = {} as Record<PayloadSection, readonly RenderedItem[]>
  for (const section of PAYLOAD_SECTION_ORDER) originals[section] = candidatesFor(rendered, section, policy)
  const rooms = passOneRooms(
    room,
    policy.relatedShare ?? DEFAULT_RELATED_SHARE,
    originals.recalled.length > 0,
    originals.related.length > 0,
  )

  const candidates = {} as Record<PayloadSection, RenderedItem[]>
  const wasCut = {} as Record<PayloadSection, boolean[]>
  const costs = {} as Record<PayloadSection, number[]>
  for (const section of PAYLOAD_SECTION_ORDER) {
    const sectionRoom = section === 'recalled' || section === 'related' ? rooms[section] : 0
    candidates[section] = originals[section].map((item, i) => ({
      ...item,
      text: i === 0 && sectionRoom > 0
        ? capItemChars(item.text, firstItemChars(section, sectionRoom, itemMaxTokens))
        : capItemText(item.text, itemMaxTokens),
    }))
    wasCut[section] = originals[section].map((item, i) => candidates[section][i]?.text !== item.text)
    costs[section] = itemCosts(section, candidates[section])
  }

  const recalled1 = extendPrefix(costs.recalled, 0, rooms.recalled)
  const related1 = extendPrefix(costs.related, 0, rooms.related)
  let left = room - recalled1.used - related1.used
  const recalled2 = extendPrefix(costs.recalled, recalled1.count, left)
  left -= recalled2.used
  const related2 = extendPrefix(costs.related, related1.count, left)
  left -= related2.used

  const counts: Record<PayloadSection, number> = {
    recalled: recalled2.count, related: related2.count, domain: 0, context: 0, faint: 0,
  }
  for (const section of ['domain', 'context', 'faint'] as const) {
    const filled = extendPrefix(costs[section], 0, left)
    counts[section] = filled.count
    left -= filled.used
    if (filled.count < costs[section].length) break
  }

  const emitted = {} as SectionItems
  let changed = false
  for (const section of PAYLOAD_SECTION_ORDER) {
    emitted[section] = candidates[section].slice(0, counts[section])
    const leftOut = counts[section] < candidates[section].length
    changed ||= leftOut || wasCut[section].slice(0, counts[section]).includes(true)
  }

  const { text, payload } = writePayload(header, emitted)
  return { text, payload: { ...payload, truncated: changed } }
}

/**
 * Build the payload text from rendered sections under a policy.
 *
 * Every section is emitted as a prefix of its items, in rank order, so the
 * first N memories and the first M associations are exactly what was shown.
 * A section heading is written only together with its first emitted item.
 * No emitted item yields ''.
 *
 * With a token budget the text never exceeds it: no item is longer than the
 * item cap, Related Memories holds its share of the room even when the
 * Recalled section could fill it all, and the first item of each of the two
 * is cut to its section's room (see `assembleWithinBudget`). A budget
 * smaller than the header emits nothing. Without one the whole payload is
 * emitted, after `emitK` and the faint switch.
 *
 * A `notice` becomes the first line, ahead of the header lines, and counts
 * against the budget like any header.
 */
export function assemble(
  rendered: RenderedPayload,
  policy: RecallOutputPolicy = DEFAULT_RECALL_OUTPUT_POLICY,
  notice?: string,
): AssembledPayload {
  if (policy.tokenBudget !== undefined) return assembleWithinBudget(rendered, policy, policy.tokenBudget, notice)
  const sections = {} as SectionItems
  for (const section of PAYLOAD_SECTION_ORDER) sections[section] = candidatesFor(rendered, section, policy)
  return writePayload(headerText(notice), sections)
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

const DECIMAL_RE = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/

function relatedShareFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const name = 'ENGRAM_RECALL_RELATED_SHARE'
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = raw.trim()
  const share = Number(value)
  if (!DECIMAL_RE.test(value) || !(share >= 0 && share <= MAX_RELATED_SHARE)) {
    throw new Error(`${name} must be a decimal from 0 to ${MAX_RELATED_SHARE}, got "${raw}"`)
  }
  return share
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
 * Read ENGRAM_RECALL_EMIT_K, ENGRAM_RECALL_TOKEN_BUDGET,
 * ENGRAM_RECALL_ITEM_MAX_TOKENS (positive integers),
 * ENGRAM_RECALL_RELATED_SHARE (decimal, 0 to MAX_RELATED_SHARE) and
 * ENGRAM_RECALL_FAINT (on|off, default on). Unset or empty means no limit or
 * the default; any other value throws, naming the variable, and so does an
 * item cap larger than the token budget when both are set.
 */
export function recallOutputPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RecallOutputPolicy {
  const emitK = positiveIntegerFromEnv(env, 'ENGRAM_RECALL_EMIT_K')
  const tokenBudget = positiveIntegerFromEnv(env, 'ENGRAM_RECALL_TOKEN_BUDGET')
  const relatedShare = relatedShareFromEnv(env)
  const itemMaxTokens = positiveIntegerFromEnv(env, 'ENGRAM_RECALL_ITEM_MAX_TOKENS')
  if (itemMaxTokens !== undefined && tokenBudget !== undefined && itemMaxTokens > tokenBudget) {
    throw new Error(
      `ENGRAM_RECALL_ITEM_MAX_TOKENS (${itemMaxTokens}) must not exceed ENGRAM_RECALL_TOKEN_BUDGET (${tokenBudget}): ` +
        'an item larger than the whole budget can never be shown',
    )
  }
  return {
    ...(emitK !== undefined ? { emitK } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(relatedShare !== undefined ? { relatedShare } : {}),
    ...(itemMaxTokens !== undefined ? { itemMaxTokens } : {}),
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
