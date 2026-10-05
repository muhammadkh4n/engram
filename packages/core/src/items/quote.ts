/**
 * The quote rule: when a statement counts as an exact quote of what was said.
 * `engram_norm_quote` in schema.sql implements the same steps, and both are
 * checked against `quote.cases.json`, so the three change together.
 *
 * 1. Unicode NFC.
 * 2. Curly single quotes become `'`, curly double quotes become `"`.
 * 3. Each run of whitespace (ASCII and the Unicode space separators) becomes
 *    one space.
 * 4. Leading and trailing spaces are removed.
 *
 * Case, dashes and zero-width characters are kept: they can change meaning,
 * and the rule only absorbs differences a copy-paste or a renderer introduces.
 */

const CURLY_SINGLE = /[\u2018\u2019\u201A\u201B]/g
const CURLY_DOUBLE = /[\u201C\u201D\u201E\u201F]/g
const WHITESPACE_RUN = /[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g
// After step 3 the only whitespace left is U+0020. String#trim is not used:
// it also strips U+FEFF, a zero-width character the rule keeps.
const EDGE_SPACES = /^ +| +$/g

export function normalizeQuote(text: string): string {
  return text
    .normalize('NFC')
    .replace(CURLY_SINGLE, "'")
    .replace(CURLY_DOUBLE, '"')
    .replace(WHITESPACE_RUN, ' ')
    .replace(EDGE_SPACES, '')
}

/** True when `quote` normalizes to a non-empty substring of normalized `text`. */
export function quoteOccursIn(quote: string, text: string): boolean {
  const needle = normalizeQuote(quote)
  return needle !== '' && normalizeQuote(text).includes(needle)
}
