import type { ResolvedItem } from './resolve.js'
import type { RecallItem, RecallOmitted } from './types.js'

export const DEFAULT_LIMIT = 12
export const DEFAULT_MAX_CHARS = 1500
export const DEFAULT_BUDGET_CHARS = 9000
/** A question longer than this keeps only its tail. */
export const QUESTION_MAX_CHARS = 600
/** Associations together take at most this share of the budget. */
export const ASSOCIATION_BUDGET_SHARE = 0.3

/** Items whose words are the record itself: shown whole or not at all. */
const UNCUTTABLE_CLASSES: ReadonlySet<string> = new Set(['mk_statement'])
const UNCUTTABLE_KINDS: ReadonlySet<string> = new Set(['ruling_entry', 'ledger_decision'])

export interface PackOptions {
  limit: number
  maxChars: number
  budgetChars: number
}

export interface PackResult {
  items: RecallItem[]
  omitted: RecallOmitted
  /** Text plus question characters across the shown items. */
  totalChars: number
}

/** Where a sentence may end: after `.`, `!` or `?` followed by whitespace, or at a newline. */
interface Boundary {
  /** The text before the boundary ends here (exclusive). */
  end: number
  /** The next sentence starts here. */
  next: number
  quoted: boolean
}

/**
 * Every sentence boundary of `text`, in order. A boundary inside a `"…"` or
 * `“…”` span is marked quoted: cutting there would end the text mid-quote. An
 * unclosed straight quote runs to the end of the text.
 */
function boundaries(text: string): Boundary[] {
  const found: Boundary[] = []
  let straightOpen = false
  let curlyDepth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (ch === '"') straightOpen = !straightOpen
    else if (ch === '“') curlyDepth += 1
    else if (ch === '”') curlyDepth = Math.max(0, curlyDepth - 1)
    const quoted = straightOpen || curlyDepth > 0
    if (ch === '\n') {
      found.push({ end: i, next: skipSpace(text, i + 1), quoted })
    } else if ((ch === '.' || ch === '!' || ch === '?') && i + 1 < text.length && /\s/.test(text[i + 1]!)) {
      found.push({ end: i + 1, next: skipSpace(text, i + 1), quoted })
    }
  }
  return found
}

function skipSpace(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/.test(text[i]!)) i += 1
  return i
}

/**
 * `text` cut at its last sentence boundary at or before `maxChars` that is
 * not inside a quote, with `cut` set. Text that fits comes back whole; text
 * with no such boundary comes back whole with `cut` false, still longer than
 * `maxChars`, for the caller to show whole or leave out.
 */
export function cutAtSentence(text: string, maxChars: number): { text: string; cut: boolean } {
  if (text.length <= maxChars) return { text, cut: false }
  let best: string | null = null
  for (const b of boundaries(text)) {
    if (b.end > maxChars) break
    if (b.quoted) continue
    const head = text.slice(0, b.end).trimEnd()
    if (head !== '') best = head
  }
  return best === null ? { text, cut: false } : { text: best, cut: true }
}

/**
 * A question over 600 characters keeps its tail from the first sentence
 * boundary that leaves at most 600; with no such boundary, its last 600
 * characters.
 */
export function cutQuestion(question: string): string {
  if (question.length <= QUESTION_MAX_CHARS) return question
  for (const b of boundaries(question)) {
    if (question.length - b.next <= QUESTION_MAX_CHARS && b.next < question.length) return question.slice(b.next)
  }
  return question.slice(question.length - QUESTION_MAX_CHARS)
}

function codePoints(text: string): number {
  let n = 0
  for (const _ of text) n += 1
  return n
}

function isUncuttable(entry: ResolvedItem): boolean {
  return UNCUTTABLE_CLASSES.has(entry.row.class) || UNCUTTABLE_KINDS.has(entry.row.kind)
}

/** The shown form of an item: its text cut or whole, or null when only the whole text may show and it is not all here. */
interface Shaped {
  text: string
  question: string | undefined
  cut: boolean
  /** True when the text is over `maxChars` and is shown whole or not at all. */
  wholeOnly: boolean
}

function shape(entry: ResolvedItem, maxChars: number): Shaped | null {
  // content_length counts code points, as PostgreSQL does; a JS length counts UTF-16 units.
  const full = codePoints(entry.row.contentHead) >= entry.row.contentLength
  const question = entry.item.question === undefined ? undefined : cutQuestion(entry.item.question)
  if (entry.item.text.length <= maxChars) {
    return full ? { text: entry.item.text, question, cut: false, wholeOnly: false } : null
  }
  const cut = isUncuttable(entry) ? { text: entry.item.text, cut: false } : cutAtSentence(entry.item.text, maxChars)
  if (cut.cut) return { text: cut.text, question, cut: true, wholeOnly: false }
  // Only the head of the content is read; a text that must show whole and is longer than the head cannot.
  return full ? { text: entry.item.text, question, cut: false, wholeOnly: true } : null
}

/** The item with its keys in the order the response lists them; absent optional fields are left out. */
function inContractOrder(item: RecallItem, text: string, question: string | undefined, flags: string[]): RecallItem {
  return {
    id: item.id,
    class: item.class,
    kind: item.kind,
    speaker: item.speaker,
    trust: item.trust,
    occurredAt: item.occurredAt,
    projectId: item.projectId,
    ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
    ...(item.subject !== undefined ? { subject: item.subject } : {}),
    text,
    ...(question !== undefined ? { question } : {}),
    source: { type: item.source.type, ref: item.source.ref },
    status: item.status,
    ...(item.supersededBy !== undefined ? { supersededBy: item.supersededBy } : {}),
    flags,
    via: item.via,
  }
}

/**
 * Packs items into the response: query items first, in the order given (each
 * replaced item already follows its replacement), then associations. Past
 * `limit` an item counts in `omitted.limit`. An item that would take the
 * text-plus-question total past `budgetChars` counts in `omitted.budget` and
 * packing goes on with the next. Associations together stay within 30% of the
 * budget. Text over `maxChars` is cut at a sentence boundary outside a quote
 * and flagged `cut`; an MK statement, register entry or plan decision, or a
 * text with no such boundary, is shown whole if it fits, else counted in
 * `omitted.uncuttable`.
 */
export class Packer {
  private readonly shown: RecallItem[] = []
  private readonly omitted: RecallOmitted = { limit: 0, budget: 0, uncuttable: 0 }
  private total = 0
  private associationTotal = 0
  private readonly associationCap: number

  constructor(private readonly opts: PackOptions) {
    this.associationCap = Math.floor(opts.budgetChars * ASSOCIATION_BUDGET_SHARE)
  }

  addQuery(entries: readonly ResolvedItem[]): void {
    for (const entry of entries) this.place(entry, false)
  }

  addAssociations(entries: readonly ResolvedItem[]): void {
    for (const entry of entries) this.place(entry, true)
  }

  /** The first `count` shown query items, by id: the seeds of the associations. */
  seeds(count: number): string[] {
    return this.shown.filter((i) => i.via === 'query').slice(0, count).map((i) => i.id)
  }

  /** Whether an association could still be shown at all. */
  hasRoomForAssociations(): boolean {
    return this.shown.length < this.opts.limit && this.associationTotal < this.associationCap && this.total < this.opts.budgetChars
  }

  result(): PackResult {
    return { items: [...this.shown], omitted: { ...this.omitted }, totalChars: this.total }
  }

  private place(entry: ResolvedItem, association: boolean): void {
    if (this.shown.length >= this.opts.limit) {
      this.omitted.limit += 1
      return
    }
    const shaped = shape(entry, this.opts.maxChars)
    if (shaped === null) {
      this.omitted.uncuttable += 1
      return
    }
    const chars = shaped.text.length + (shaped.question?.length ?? 0)
    const fits = this.total + chars <= this.opts.budgetChars && (!association || this.associationTotal + chars <= this.associationCap)
    if (!fits) {
      if (shaped.wholeOnly) this.omitted.uncuttable += 1
      else this.omitted.budget += 1
      return
    }
    const flags = shaped.cut ? [...new Set([...entry.item.flags, 'cut'])].sort() : entry.item.flags
    this.shown.push(inContractOrder(entry.item, shaped.text, shaped.question, flags))
    this.total += chars
    if (association) this.associationTotal += chars
  }
}
