/**
 * Finds where a value ends from the quoting and word structure around it —
 * matching quotes, escapes, shell words, line ends — never from which
 * characters the value contains, so a password made of any printable
 * characters is covered to its last one.
 */

/** Line boundaries of one text, computed once so per-key lookups stay cheap on long single-line inputs. */
export class Lines {
  private readonly breaks: number[] = []

  constructor(private readonly text: string) {
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) this.breaks.push(i)
  }

  private breakIndexAtOrAfter(offset: number): number {
    let lo = 0
    let hi = this.breaks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.breaks[mid]! < offset) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Offset of the `\n` ending the line that holds `offset`, or the text length. A trailing `\r` is excluded. */
  endOf(offset: number): number {
    const i = this.breakIndexAtOrAfter(offset)
    const end = i < this.breaks.length ? this.breaks[i]! : this.text.length
    return end > offset && this.text.charAt(end - 1) === '\r' ? end - 1 : end
  }

  startOf(offset: number): number {
    const i = this.breakIndexAtOrAfter(offset)
    return i === 0 ? 0 : this.breaks[i - 1]! + 1
  }
}

const QUOTES = new Set(['"', "'", '`'])

export function isQuote(ch: string): boolean {
  return QUOTES.has(ch)
}

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'
}

function escapedClose(text: string, open: number, limit: number): number {
  const q = text.charAt(open)
  for (let i = open + 1; i < limit; i++) {
    const ch = text.charAt(i)
    if (ch === '\\') i++
    else if (ch === q) return i
  }
  return -1
}

function literalClose(text: string, open: number, limit: number): number {
  const close = text.indexOf(text.charAt(open), open + 1)
  return close !== -1 && close < limit ? close : -1
}

/**
 * Close of one quoted segment. Backslash escapes the next character in JSON,
 * JS and shell double quotes; shell single quotes have no escapes
 * (`'abc\'` ends at the last quote). `shellSingle` picks the shell reading.
 */
function segmentClose(text: string, open: number, limit: number, shellSingle: boolean): number {
  if (text.charAt(open) === "'" && shellSingle) return literalClose(text, open, limit)
  const close = escapedClose(text, open, limit)
  return close === -1 && text.charAt(open) === "'" ? literalClose(text, open, limit) : close
}

/**
 * End of a quoted value opened at `open`, continued through shell
 * quote-concatenation (`'it'\''s'`, `'a'"'"'b'`): the offset of its last
 * closing quote, or past a trailing escape; -1 when a segment never closes,
 * which means the text is not in this reading's language.
 */
function quotedEndAs(text: string, open: number, limit: number, shellSingle: boolean): number {
  const first = segmentClose(text, open, limit, shellSingle)
  if (first === -1) return -1
  let end = first
  let i = first + 1
  while (i < limit) {
    const ch = text.charAt(i)
    if (ch === '\\' && i + 1 < limit) {
      i += 2
      end = i
      continue
    }
    if (ch !== "'" && ch !== '"') break
    const close = segmentClose(text, i, limit, shellSingle)
    if (close === -1) return -1
    end = close
    i = close + 1
  }
  return end
}

/**
 * Where the content of a quoted value ends, or -1 when it never closes. A
 * single-quoted value is read both as JS/JSON (escapes) and as shell (no
 * escapes); of the readings that close, the later end wins: which language the
 * text is in cannot always be told, and a value cut short leaks its tail.
 */
export function quotedValueEnd(text: string, open: number, limit: number): number {
  const escaped = quotedEndAs(text, open, limit, false)
  if (text.charAt(open) !== "'") return escaped
  return Math.max(escaped, quotedEndAs(text, open, limit, true))
}

/** Offset just past the bracket closing the one at `open` (`(`, `{`), or -1. */
function matchingBracket(text: string, open: number, limit: number): number {
  const opener = text.charAt(open)
  const closer = opener === '(' ? ')' : '}'
  let depth = 0
  for (let i = open; i < limit; i++) {
    const ch = text.charAt(i)
    if (ch === '\\') i++
    else if (ch === opener) depth++
    else if (ch === closer && --depth === 0) return i + 1
  }
  return -1
}

/** -1 when a quoted segment never closes: the text is not in this reading's language. */
function shellWordEndAs(text: string, start: number, limit: number, shellSingle: boolean): number {
  let i = start
  while (i < limit && !isBlank(text.charAt(i))) {
    const ch = text.charAt(i)
    if (ch === '\\') {
      i += 2
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const close = segmentClose(text, i, limit, shellSingle)
      // An unpaired backtick closes markdown inline code around the word.
      if (close === -1 && ch === '`') break
      if (close === -1) return -1
      i = close + 1
    } else if (ch === '$' && (text.charAt(i + 1) === '(' || text.charAt(i + 1) === '{')) {
      const end = matchingBracket(text, i + 1, limit)
      i = end === -1 ? limit : end
    } else {
      i++
    }
  }
  return Math.min(i, limit)
}

/**
 * End of the shell word starting at `start`: unescaped whitespace or `limit`.
 * Quoted segments, backslash escapes, `$(…)`, `${…}` and backticks are part of
 * the word even when they contain whitespace; a single-quoted segment is read
 * with and without backslash escapes and the later valid end wins.
 */
export function shellWordEnd(text: string, start: number, limit: number): number {
  const end = Math.max(shellWordEndAs(text, start, limit, true), shellWordEndAs(text, start, limit, false))
  if (end !== -1) return end
  // A quote that never closes under any reading is a plain character (or the
  // close of a string the word sits in); the word ends at whitespace.
  let i = start
  while (i < limit && !isBlank(text.charAt(i))) i++
  return i
}

const SHELL_VARIABLE_RE = /^\$[A-Za-z_]\w*$|^%[A-Za-z_]\w*%$/

/** `$VAR`, `${…}`, `$(…)`, `%VAR%` as the whole value: resolved elsewhere, never a literal. */
export function isShellReference(value: string): boolean {
  if (SHELL_VARIABLE_RE.test(value)) return true
  if (!value.startsWith('$(') && !value.startsWith('${')) return false
  return matchingBracket(value, 1, value.length) === value.length
}
