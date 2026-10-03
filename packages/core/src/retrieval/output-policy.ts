import type { MemoryType, RecallDegradation } from '../types.js'

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

/** Smallest ENGRAM_RECALL_TOKEN_BUDGET: the header plus one section's
 *  `MIN_SECTION_ROOM_CHARS`. A smaller budget leaves no section room for a
 *  memory, so every recall would answer that the budget is too small. */
export const MIN_RECALL_TOKEN_BUDGET = Math.ceil(
  (PAYLOAD_HEADER_LINES.join('\n').length + MIN_SECTION_ROOM_CHARS) / CHARS_PER_TOKEN,
)

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

/** Share of the cut room the word-boundary search may give back. A longer
 *  search would drop more of the content to land on a space than a hard cut
 *  costs the reader. */
export const CUT_BOUNDARY_WINDOW = 0.2

/** Content chars every cut item keeps, or all of a shorter content. Fewer
 *  would show the tag and a word or two, which reads as a memory without
 *  saying anything. */
export const MIN_CUT_CONTENT_CHARS = 40

// Shapes of the `- [type · role · device/channel · date] ` tag a memory item
// opens with (`formatTag` in engine.ts); each part is optional except the type.
const TAG_MEMORY_TYPES: Readonly<Record<MemoryType, true>> = { episode: true, digest: true, semantic: true, procedural: true }
const TAG_ROLES = ['user', 'assistant', 'system'] as const
const TAG_CHANNELS = ['WhatsApp', 'Telegram'] as const
/** Longest device name a tag carries; the formatter clips a longer one. */
export const MAX_TAG_DEVICE_CHARS = 32
const TAG_DATE_CHARS = 'YYYY-MM-DD'.length
const TAG_SEPARATOR = ' · '
const longestOf = (words: readonly string[]) => Math.max(...words.map((word) => word.length))

/** Longest rendered memory tag, from `- [` to the space after `]`. */
export const MAX_TAG_CHARS =
  '- ['.length +
  longestOf(Object.keys(TAG_MEMORY_TYPES)) +
  TAG_SEPARATOR.length + longestOf(TAG_ROLES) +
  TAG_SEPARATOR.length + MAX_TAG_DEVICE_CHARS + '/'.length + longestOf(TAG_CHANNELS) +
  TAG_SEPARATOR.length + TAG_DATE_CHARS +
  '] '.length

/** Smallest ENGRAM_RECALL_ITEM_MAX_TOKENS: a cap that holds the longest tag,
 *  `MIN_CUT_CONTENT_CHARS` content chars and the cut marker. A smaller cap
 *  leaves out every long memory whose tag it cannot hold with content. */
export const MIN_ITEM_MAX_TOKENS = Math.ceil(
  (MAX_TAG_CHARS + MIN_CUT_CONTENT_CHARS + ITEM_CUT_MARKER.length) / CHARS_PER_TOKEN,
)

/** Index of the first content char of a rendered item: after the
 *  `- [type · role · date] ` tag of a memory, after the `- ` bullet of an
 *  untagged line. */
export function itemContentStart(text: string): number {
  if (text.startsWith('- [')) {
    const tagEnd = text.indexOf('] ')
    if (tagEnd >= 0) return tagEnd + 2
  }
  return text.startsWith('- ') ? 2 : 0
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * Cut an item line to at most `maxChars` chars, ending in `ITEM_CUT_MARKER`.
 * The cut lands at the last word boundary within `CUT_BOUNDARY_WINDOW` of the
 * room, otherwise hard at the room and never inside a surrogate pair. It
 * never lands inside or right after the item's tag: the kept text holds at
 * least `MIN_CUT_CONTENT_CHARS` content chars (or the whole content when it
 * is shorter), and an item whose room cannot hold that is not emittable
 * (`undefined`). Text that fits is returned unchanged.
 */
export function capItemChars(text: string, maxChars: number): string | undefined {
  if (text.length <= maxChars) return text
  const room = maxChars - ITEM_CUT_MARKER.length
  const contentStart = itemContentStart(text)
  const minEnd = contentStart + Math.max(1, Math.min(text.length - contentStart, MIN_CUT_CONTENT_CHARS))
  if (room < minEnd) return undefined
  const lowest = Math.max(minEnd, room - Math.floor(room * CUT_BOUNDARY_WINDOW))
  for (let end = room; end >= lowest; end--) {
    if (/\s/.test(text[end] ?? '') && !/\s/.test(text[end - 1] ?? '')) return `${text.slice(0, end)}${ITEM_CUT_MARKER}`
  }
  const end = isHighSurrogate(text.charCodeAt(room - 1)) ? room - 1 : room
  return end < minEnd ? undefined : `${text.slice(0, end)}${ITEM_CUT_MARKER}`
}

/** Smallest `maxChars` for which `capItemChars` returns text: the whole item
 *  when it is that short, otherwise its tag, the minimum content (one char
 *  more when the last of it opens a surrogate pair) and the marker. */
export function minItemChars(text: string): number {
  const contentStart = itemContentStart(text)
  let minEnd = contentStart + Math.max(1, Math.min(text.length - contentStart, MIN_CUT_CONTENT_CHARS))
  if (isHighSurrogate(text.charCodeAt(minEnd - 1))) minEnd++
  return Math.min(text.length, minEnd + ITEM_CUT_MARKER.length)
}

/** `capItemChars` with the limit in tokens. */
export function capItemText(text: string, maxTokens: number): string | undefined {
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
 *  '\n' and the item, plus the section heading for the first. An item whose
 *  cut could not keep content (`undefined`) costs Infinity, so it never fits
 *  and ends its section's prefix. */
function itemCosts(section: PayloadSection, texts: readonly (string | undefined)[]): number[] {
  return texts.map((text, i) =>
    text === undefined ? Infinity : (i === 0 ? 1 + PAYLOAD_SECTION_HEADERS[section].length : 0) + 1 + text.length,
  )
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
 * `room · share` and Recalled the rest, but Related never takes the room
 * Recalled needs to show its first item (`recalledNeed`, `undefined` when
 * Recalled has no candidates), so the best-ranked memory is never displaced
 * by associations. A section with no candidates reserves nothing, and neither
 * does one whose room is below `MIN_SECTION_ROOM_CHARS` (unless that room is
 * what Recalled needs); the other section then holds the whole room.
 */
function passOneRooms(room: number, share: number, recalledNeed: number | undefined, hasRelated: boolean): PassOneRooms {
  const atLeastFloor = (chars: number) => (chars >= MIN_SECTION_ROOM_CHARS ? chars : 0)
  if (!hasRelated) return { recalled: recalledNeed !== undefined ? atLeastFloor(room) : 0, related: 0 }
  if (recalledNeed === undefined) return { recalled: 0, related: atLeastFloor(room) }
  const recalledMin = recalledNeed <= room ? recalledNeed : 0
  const related = Math.min(Math.floor(room * share), room - recalledMin)
  if (related < MIN_SECTION_ROOM_CHARS) return { recalled: atLeastFloor(room), related: 0 }
  if (recalledMin === 0 && room - related < MIN_SECTION_ROOM_CHARS) return { recalled: 0, related: room }
  return { recalled: room - related, related }
}

/** Chars a section's first item needs to be shown: the heading, the joining
 *  newlines and the item's shortest showable cut. Infinity when the item cap cannot
 *  hold that cut. */
function firstItemNeed(section: PayloadSection, text: string, itemMaxTokens: number): number {
  const shortest = minItemChars(text)
  return shortest > itemMaxTokens * CHARS_PER_TOKEN ? Infinity : 1 + PAYLOAD_SECTION_HEADERS[section].length + 1 + shortest
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
 * the budget. Pass 1: Related takes the prefix that fits its room (see
 * `passOneRooms`), its first item cut to fit that room. The first Recalled
 * item is then cut to the room Recalled can actually reach, its own pass-1
 * room plus what Related left unused, and Recalled takes the prefix that fits
 * there. Pass 2: room Related left goes back to Related. So every section that
 * holds room shows its first memory whatever the share, as long as the room
 * and the item cap can hold the item's tag and its minimum content (see
 * `capItemChars`), and Related never shows an association while a Recalled
 * memory that fits the whole room goes unshown. An item no cut can show
 * content for is never emitted and ends its section's prefix. Domain, Context
 * and Faint then fill what is left in order; the first of their items that
 * does not fit ends assembly.
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
  const firstRecalled = originals.recalled[0]
  const rooms = passOneRooms(
    room,
    policy.relatedShare ?? DEFAULT_RELATED_SHARE,
    firstRecalled !== undefined ? firstItemNeed('recalled', firstRecalled.text, itemMaxTokens) : undefined,
    originals.related.length > 0,
  )

  const cutTexts = {} as Record<PayloadSection, (string | undefined)[]>
  const costs = {} as Record<PayloadSection, number[]>
  const cutSection = (section: PayloadSection, firstRoom: number) => {
    cutTexts[section] = originals[section].map((item, i) =>
      i === 0 && firstRoom > 0
        ? capItemChars(item.text, firstItemChars(section, firstRoom, itemMaxTokens))
        : capItemText(item.text, itemMaxTokens),
    )
    costs[section] = itemCosts(section, cutTexts[section])
  }
  for (const section of ['related', 'domain', 'context', 'faint'] as const) {
    cutSection(section, section === 'related' ? rooms.related : 0)
  }

  const related1 = extendPrefix(costs.related, 0, rooms.related)
  const recalledReach = room - related1.used
  cutSection('recalled', recalledReach)
  const recalled = extendPrefix(costs.recalled, 0, recalledReach)
  let left = recalledReach - recalled.used
  const related2 = extendPrefix(costs.related, related1.count, left)
  left -= related2.used

  const counts: Record<PayloadSection, number> = {
    recalled: recalled.count, related: related2.count, domain: 0, context: 0, faint: 0,
  }
  for (const section of ['domain', 'context', 'faint'] as const) {
    const filled = extendPrefix(costs[section], 0, left)
    counts[section] = filled.count
    left -= filled.used
    if (filled.count < costs[section].length) break
  }

  // Every emitted item has a cut text: an unemittable one costs Infinity and
  // ends its prefix, so `counts` never reaches past it.
  const emitted = {} as SectionItems
  let changed = false
  for (const section of PAYLOAD_SECTION_ORDER) {
    const shown = originals[section].slice(0, counts[section])
    emitted[section] = shown.map((item, i) => ({ ...item, text: cutTexts[section][i] ?? '' }))
    const leftOut = counts[section] < originals[section].length
    changed ||= leftOut || shown.some((item, i) => cutTexts[section][i] !== item.text)
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
 * Recalled section could fill it all (but never the room the first Recalled
 * memory needs), and the first item of each of the two is cut to the room
 * its section can reach (see `assembleWithinBudget`). A budget
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
 * the default; any other value throws, naming the variable, and so do a
 * token budget below `MIN_RECALL_TOKEN_BUDGET`, an item cap below
 * `MIN_ITEM_MAX_TOKENS` and an item cap larger than the token budget when
 * both are set.
 */
export function recallOutputPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RecallOutputPolicy {
  const emitK = positiveIntegerFromEnv(env, 'ENGRAM_RECALL_EMIT_K')
  const tokenBudget = positiveIntegerFromEnv(env, 'ENGRAM_RECALL_TOKEN_BUDGET')
  const relatedShare = relatedShareFromEnv(env)
  const itemMaxTokens = positiveIntegerFromEnv(env, 'ENGRAM_RECALL_ITEM_MAX_TOKENS')
  if (tokenBudget !== undefined && tokenBudget < MIN_RECALL_TOKEN_BUDGET) {
    throw new Error(
      `ENGRAM_RECALL_TOKEN_BUDGET must be at least ${MIN_RECALL_TOKEN_BUDGET}, got ${tokenBudget}: ` +
        'a smaller budget leaves no room for a single memory after the header',
    )
  }
  if (itemMaxTokens !== undefined && itemMaxTokens < MIN_ITEM_MAX_TOKENS) {
    throw new Error(
      `ENGRAM_RECALL_ITEM_MAX_TOKENS must be at least ${MIN_ITEM_MAX_TOKENS}, got ${itemMaxTokens}: ` +
        `a smaller cap cannot hold a memory's tag (up to ${MAX_TAG_CHARS} chars) and ${MIN_CUT_CONTENT_CHARS} chars of its content`,
    )
  }
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
