/**
 * What recall reads off a query to decide which model steps to run and which
 * terms the lexical leg searches. The old engine's classifier stays as it is;
 * these differ from it where its rules misfired on real queries.
 */
import { isMultiHopQuery } from '../retrieval/query-classifier.js'

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec'
const TIME_WORDS =
  'january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday'
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve'
/** A 19xx or 20xx number that is not part of a longer number, word or key; it reads as a year only in YEAR_IN_CONTEXT. */
const YEAR = '(?<![A-Za-z0-9-])(?:19|20)\\d{2}(?![0-9])'

/**
 * The old classifier's temporal rules without its two bare-year rules, which
 * fired on any 19xx/20xx number: a tenant id ("tenant 1933") or a ticket key
 * ending in 2031 made a lookup temporal, and so ran HyDE on it.
 */
const TEMPORAL_RULES: readonly RegExp[] = [
  /\b(?:when|what\s+(?:year|date|month|day|time))\b/i,
  new RegExp(`\\b(?:before|after|during|since|until|by)\\s+(?:the\\s+|a\\s+|\\d|${TIME_WORDS})\\b`, 'i'),
  /\b(?:yesterday|today|tomorrow|tonight)\b/i,
  new RegExp(
    `\\b(?:last|this|next|previous|past)\\s+(?:week|month|year|day|time|night|morning|afternoon|evening|weekend|${TIME_WORDS})\\b`,
    'i',
  ),
  new RegExp(`\\b(?:a|an|\\d+|${NUMBER_WORDS})\\s+(?:day|week|month|year|hour|minute)s?\\s+ago\\b`, 'i'),
  /\b(?:recently|earlier|later|afterwards|beforehand|meanwhile)\b/i,
  /\bhow\s+long\s+(?:ago|between|did|since|until)\b/i,
]

/**
 * A year counts only where it reads as a date: next to a month name ("March
 * 2025", "2025 March", "March 3, 2025"), after "in" or "since", or next to
 * the word year ("the year 2025", "2025 year").
 */
const YEAR_IN_CONTEXT: readonly RegExp[] = [
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?${YEAR}`, 'i'),
  new RegExp(`${YEAR}\\s+(?:${MONTHS})\\b`, 'i'),
  new RegExp(`\\b(?:in|since)\\s+${YEAR}`, 'i'),
  new RegExp(`\\byears?\\s+${YEAR}`, 'i'),
  new RegExp(`${YEAR}\\s+years?\\b`, 'i'),
]

export function isTemporal(query: string): boolean {
  return TEMPORAL_RULES.some((re) => re.test(query)) || YEAR_IN_CONTEXT.some((re) => re.test(query))
}

/** The old classifier's multi-hop rules, unchanged. */
export function isMultiHop(query: string): boolean {
  return isMultiHopQuery(query)
}

const RECALL_WORDS = /\b(remember|recall|what did|did we|last time|previously|have we|remind me)\b/i

/** A question, or a request to recall something: the old intent analyzer's deep-mode signals. */
export function isLookupQuestion(query: string): boolean {
  return query.includes('?') || RECALL_WORDS.test(query)
}

/** The old lexical search's stop words. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was',
  'this', 'that', 'have', 'with', 'from', 'they', 'been', 'has', 'will',
  'its', 'our', 'let', 'did', 'how', 'what', 'who', 'why', 'when', 'where',
  'about', 'know', 'remember', 'tell', 'show', 'does',
])
const MAX_TERMS = 64
const SPLIT = /[\s?!,;:()[\]{}"'`]+/

/** Strips a trailing `.` and edge `-` until neither is left: "claude.ai." is "claude.ai". */
function trimEdges(token: string): string {
  let t = token
  for (;;) {
    const next = t.replace(/\.+$/, '').replace(/^-+/, '').replace(/-+$/, '')
    if (next === t) return t
    t = next
  }
}

/**
 * The terms the lexical leg searches: identifiers stay whole, so a file name,
 * a package, a version or a host matches as one phrase ("index.ts",
 * "rerank-onnx", "v0.3.15"). Split on whitespace and `?!,;:()[]{}"'` and the
 * backtick; inner `.`, `-`, `_`, `/`, `@` and `#` are kept; lowercased; tokens
 * under two characters and stop words dropped; first occurrence kept; at most
 * 64.
 */
export function lexicalTerms(query: string): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  for (const raw of query.split(SPLIT)) {
    const term = trimEdges(raw).toLowerCase()
    if (term.length < 2 || STOP_WORDS.has(term) || seen.has(term)) continue
    seen.add(term)
    terms.push(term)
    if (terms.length === MAX_TERMS) break
  }
  return terms
}
