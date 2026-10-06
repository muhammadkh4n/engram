/**
 * Locating a quote in the text it came from. Acceptance is always
 * `quoteOccursIn`, the rule the database trigger shares; this module only
 * finds where an accepted quote sits, so the stored characters are the
 * speaker's own rather than the model's copy of them.
 *
 * `normalizeWithMap` applies the quote rule's steps after NFC (curly quotes
 * become straight, whitespace runs become one space, edge spaces go) and keeps,
 * for every character it emits, the index of the original character it came
 * from. NFC is left out on purpose: composing characters would break the
 * one-to-one map, so a span is located only in text that is already NFC.
 */
import { normalizeQuote } from '../items/quote.js'

const CURLY_SINGLE = /[\u2018\u2019\u201a\u201b]/
const CURLY_DOUBLE = /[\u201c\u201d\u201e\u201f]/
const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/

export interface NormalizedText {
  norm: string
  /** `map[i]` is the index in the original text of `norm[i]`. */
  map: number[]
}

/** A half-open range of UTF-16 indexes into the original text. */
export interface TextSpan {
  start: number
  end: number
}

export function normalizeWithMap(text: string): NormalizedText {
  const chars: string[] = []
  const map: number[] = []
  let inWhitespace = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (WHITESPACE.test(ch)) {
      if (!inWhitespace) {
        chars.push(' ')
        map.push(i)
      }
      inWhitespace = true
      continue
    }
    inWhitespace = false
    chars.push(CURLY_SINGLE.test(ch) ? "'" : CURLY_DOUBLE.test(ch) ? '"' : ch)
    map.push(i)
  }
  let start = 0
  let end = chars.length
  while (start < end && chars[start] === ' ') start++
  while (end > start && chars[end - 1] === ' ') end--
  return { norm: chars.slice(start, end).join(''), map: map.slice(start, end) }
}

/**
 * The span of `haystack` holding the first match of `needle` under the quote
 * rule, or null. Meaningful only when `haystack` is NFC.
 */
export function findSpan(haystack: string, needle: string): TextSpan | null {
  const target = normalizeQuote(needle)
  if (target === '') return null
  const { norm, map } = normalizeWithMap(haystack)
  const at = norm.indexOf(target)
  if (at < 0) return null
  return { start: map[at]!, end: map[at + target.length - 1]! + 1 }
}

export function isNfc(text: string): boolean {
  return text === text.normalize('NFC')
}

/**
 * The characters to store for a quote already accepted from `haystack`: the
 * original span when the haystack is NFC (transcript text is), else the
 * model's string, which the trigger accepts as well.
 */
export function exactSpan(haystack: string, quote: string): string {
  if (!isNfc(haystack)) return quote
  const span = findSpan(haystack, quote)
  return span === null ? quote : haystack.slice(span.start, span.end)
}
