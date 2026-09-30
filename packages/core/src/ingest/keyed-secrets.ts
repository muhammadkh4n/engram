/**
 * Free-text heuristic: values assigned to secret-named keys. The key's name
 * decides whether the value may be a credential (see secret-keys.ts); the
 * syntax around the pair decides where the value ends. Empty values, shell
 * references (`$X`, `${X}`, `$(…)`), code references in code syntax
 * (identifiers, member paths, calls, type annotations) and typed `true` /
 * `null` in YAML, JSON and JS are skipped, as are placeholders.
 *
 * Also covers credentials passed as CLI arguments: `--password value`,
 * `curl -u user:pass`, `mysql -p'…'`.
 *
 * Detect-only: these spans feed findSecretCandidates and never redact.
 */

import { isOnlyPlaceholders } from './placeholder.js'
import { isCandidateSecretKey, isPublicKey, isPublishableValue } from './secret-keys.js'
import type { DetectedSpan } from './secretlint-spans.js'
import { Lines, isQuote, isShellReference, quotedValueEnd, shellWordEnd } from './value-extent.js'

export const KEYED_RANK = 0

// A key, optionally quoted, then `=`, `:`, `:=` or (after a quoted key, as in
// PHP and Ruby hashes) `=>`. `::` (paths) and `://` (URLs, whose userinfo has
// its own rule) are not separators. Key names are length-bounded so long
// identifier-like runs cost linear time.
const KEY_RE = /(?<![\w.$/])(["'`]?)([A-Za-z_][\w.-]{0,127})\1(\?)?([ \t]*(?:\*\*|__)?[ \t]*)(:=|=>?|:(?![:/]))/g

const AUTH_SCHEME_RE = /^(?:Bearer|Basic|Token|Digest)[ \t]+/i

// Unquoted keywords that YAML, JSON and JS read as typed values, not strings.
const TYPED_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'none', 'nil', '~'])
const TYPE_KEYWORD = String.raw`(?:string|number|boolean|bigint|symbol|object|unknown|any|never|void|null|undefined)(?:\[\])*`
const TYPE_ANNOTATION_RE = new RegExp(String.raw`^${TYPE_KEYWORD}(?:\s*[|&]\s*${TYPE_KEYWORD})*\s*[,;]?$`)

// In code syntax, an identifier, member path or call is a reference to where
// the secret lives, and `[`, `{`, `(` open an expression.
const CODE_REFERENCE_RE =
  /^(?:(?:await|new|typeof|yield)[ \t]+)?[A-Za-z_$][\w$]*(?:!|\??\.[A-Za-z_$#][\w$]*)*(?=$|[\s,;:)\]}(\[.?!|&+\-*/%<>=])/
const EXPRESSION_START_RE = /^[[{(]/
// `this.apiKey = options.apiKey`, `token = await getToken()`: code even without a trailing `;`.
const MEMBER_OR_CALL_RE =
  /^(?:(?:await|new)[ \t]+)?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$#][\w$]*)*(?:\??\.[A-Za-z_$#][\w$]*|\()/
const CODE_LINE_END_RE = /[,;{(]\s*$/

// What may precede a key that starts its line: indentation, a `grep -n` or
// `cat -n` location, a diff marker, a list bullet, markdown emphasis.
const LINE_PREFIX_RE = /^(?:\S*?:\d+[:-])?(?:[ \t]*\d+(?:→|\t|:|\|))?[ \t]*(?:[+>-][ \t]*)?(?:[-*][ \t]+)?(?:\*\*|__)?$/
const MAX_LINE_PREFIX = 256
// A backtick template may span lines; the bound keeps an unclosed one cheap.
const MAX_TEMPLATE_LENGTH = 4096

interface KeyedPair {
  keyStart: number
  keyQuote: string
  name: string
  gap: string
  sep: string
  valueFrom: number
}

type Span = [number, number]

function isBlank(ch: string): boolean {
  return ch === ' ' || ch === '\t'
}

function skipBlanks(text: string, from: number, limit: number): number {
  let i = from
  while (i < limit && isBlank(text.charAt(i))) i++
  return i
}

function isLineLeading(text: string, lines: Lines, offset: number): boolean {
  const start = lines.startOf(offset)
  return offset - start <= MAX_LINE_PREFIX && LINE_PREFIX_RE.test(text.slice(start, offset))
}

function isTypedLiteral(value: string): boolean {
  return TYPED_LITERALS.has(value.replace(/[,;]\s*$/, '').trim().toLowerCase())
}

/** Applies the exemptions every syntax shares and returns the span to redact. */
function literalSpan(text: string, from: number, end: number, sep: string): Span | null {
  const value = text.slice(from, end)
  const trimmed = value.trim()
  if (trimmed === '' || isShellReference(trimmed) || isOnlyPlaceholders(value) || isPublishableValue(trimmed)) return null
  if (sep === ':' && (isTypedLiteral(trimmed) || TYPE_ANNOTATION_RE.test(trimmed))) return null
  return [from, end]
}

function withoutScheme(text: string, from: number, end: number): number {
  const scheme = AUTH_SCHEME_RE.exec(text.slice(from, end))
  return scheme ? from + scheme[0].length : from
}

type SyntaxKind = 'shell' | 'data' | 'code'

// After a quoted scalar a data line may hold only a comment; anything else
// means the quote was part of an unquoted value that runs to the line end.
const AFTER_QUOTED_RE = /^\s*(?:$|#|\/\/)/

/** End of a quoted value in shell: the whole shell word, less its final closing quote. */
function shellQuotedEnd(text: string, open: number, lineEnd: number): number {
  const wordEnd = shellWordEnd(text, open, lineEnd)
  const last = text.charAt(wordEnd - 1)
  return wordEnd - 1 > open && (last === "'" || last === '"') ? wordEnd - 1 : wordEnd
}

/** Content range of a quoted value; on a data line with text after the closing quote, the quote was content. */
function quotedRange(text: string, lines: Lines, open: number, syntax: SyntaxKind): Span {
  const lineEnd = lines.endOf(open)
  if (syntax === 'shell') return [open + 1, shellQuotedEnd(text, open, lineEnd)]
  const limit = text.charAt(open) === '`' ? Math.min(text.length, open + MAX_TEMPLATE_LENGTH) : lineEnd
  const end = quotedValueEnd(text, open, limit)
  if (end === -1) return [open + 1, lineEnd]
  if (syntax === 'data' && !AFTER_QUOTED_RE.test(text.slice(end + 1, lines.endOf(end)))) return [open, lines.endOf(end)]
  return [open + 1, end]
}

/**
 * A quoted value runs to its matching unescaped quote, continued through
 * shell quote-concatenation (`'it'\''s'`). Double quotes may hold a shell
 * reference; a backtick holding `${…}` is a template and, in shell, a command
 * substitution. Single quotes are always literal.
 */
function quotedSpan(text: string, lines: Lines, open: number, syntax: SyntaxKind): Span | null {
  const q = text.charAt(open)
  const [from, end] = quotedRange(text, lines, open, syntax)
  const value = text.slice(from, end)
  if (q === '`' && (value.includes('${') || syntax === 'shell')) return null
  if (q === "'" && value === '') return null
  // Single quotes and JS templates do not expand `$`: `'$ecret'` is a literal.
  if (q !== '"' && isShellReference(value.trim())) return [from, end]
  return literalSpan(text, withoutScheme(text, from, end), end, '')
}

function queryValueEnd(text: string, from: number, limit: number): number {
  let i = from
  while (i < limit && !/[&#"'<>\s]/.test(text.charAt(i))) i++
  return i
}

/**
 * The pair sits inside a string (`-H "X-Api-Key: v"`, `-e "PASS=v"`, markdown
 * `` `PASS=v` ``): the value ends where that string does.
 */
function enclosedSpan(text: string, lines: Lines, pair: KeyedPair, from: number): Span | null {
  const lineEnd = lines.endOf(from)
  const close = quotedValueEnd(text, pair.keyStart - 1, lineEnd)
  const end = close === -1 ? lineEnd : close
  if (end <= from) return null
  return literalSpan(text, withoutScheme(text, from, end), end, pair.sep)
}

/** `X-Api-Key:`, `db.password:`: a key no JS object literal can hold unquoted. */
function isHeaderKey(pair: KeyedPair): boolean {
  return pair.sep === ':' && pair.gap === '' && !pair.keyQuote && /[-.]/.test(pair.name)
}

/** `:=` is an assignment in Go and Pascal, never a data format. */
function isDataLine(text: string, lines: Lines, pair: KeyedPair, rest: string): boolean {
  if (pair.sep === ':=' || !isLineLeading(text, lines, pair.keyStart)) return false
  return isHeaderKey(pair) || !CODE_LINE_END_RE.test(rest)
}

/**
 * Unquoted `key: value` / `key = value`. A line-leading pair with nothing
 * code-like after it (YAML, INI, HTTP headers, env dumps) takes the rest of
 * the line; mid-line, a header-style key (`X-Api-Key:`, `db.password:`) or an
 * auth scheme takes one shell word. Anything else is code, where names,
 * calls and expressions are references and only other text is redacted.
 */
function unquotedPairSpan(text: string, lines: Lines, pair: KeyedPair, from: number, lineEnd: number): Span | null {
  const rest = text.slice(from, lineEnd)
  const lineLeading = isLineLeading(text, lines, pair.keyStart)
  if (AUTH_SCHEME_RE.test(rest)) {
    const valueFrom = withoutScheme(text, from, lineEnd)
    return literalSpan(text, valueFrom, lineLeading ? lineEnd : shellWordEnd(text, valueFrom, lineEnd), pair.sep)
  }
  const headerKey = isHeaderKey(pair)
  const dataLine = isDataLine(text, lines, pair, rest)
  if (dataLine && pair.sep === '=' && MEMBER_OR_CALL_RE.test(rest)) return null
  if (dataLine) return literalSpan(text, from, lineEnd, pair.sep)
  if (headerKey) return literalSpan(text, from, shellWordEnd(text, from, lineEnd), pair.sep)
  if (EXPRESSION_START_RE.test(rest) || CODE_REFERENCE_RE.test(rest) || isTypedLiteral(rest.split(/\s/)[0] ?? '')) return null
  return literalSpan(text, from, shellWordEnd(text, from, lineEnd), pair.sep)
}


function quotedSyntax(text: string, lines: Lines, pair: KeyedPair, from: number, lineEnd: number): SyntaxKind {
  if (pair.sep === '=' && pair.gap === '') return 'shell'
  return isDataLine(text, lines, pair, text.slice(from, lineEnd)) ? 'data' : 'code'
}

function valueSpan(text: string, lines: Lines, pair: KeyedPair): Span | null {
  const { keyStart, keyQuote, gap, sep } = pair
  const lineEnd = lines.endOf(pair.valueFrom)
  const shellAssignment = sep === '=' && gap === ''
  let from = pair.valueFrom
  if (shellAssignment) {
    // `NAME= next`: the shell assigns the empty string.
    if (from >= lineEnd || isBlank(text.charAt(from))) return null
  } else {
    from = skipBlanks(text, from, lineEnd)
    if (/^(?:\*\*|__)/.test(text.slice(from, from + 2)) && /(?:\*\*|__)$/.test(text.slice(keyStart - 2, keyStart))) {
      from = skipBlanks(text, from + 2, lineEnd)
    }
  }
  if (from >= lineEnd) return null
  const before = text.charAt(keyStart - 1)
  const enclosing = !keyQuote && isQuote(before) ? before : ''
  const ch = text.charAt(from)
  if (enclosing) return enclosedSpan(text, lines, pair, from)
  if (isQuote(ch)) return quotedSpan(text, lines, from, quotedSyntax(text, lines, pair, from, lineEnd))
  if (shellAssignment && (before === '?' || before === '&')) {
    return literalSpan(text, from, queryValueEnd(text, from, lineEnd), sep)
  }
  if (shellAssignment) return literalSpan(text, from, shellWordEnd(text, from, lineEnd), sep)
  return unquotedPairSpan(text, lines, pair, from, lineEnd)
}

/**
 * `=>` is an arrow function unless the key is quoted. A spaced `==`, `===` or
 * `=~` is a comparison or a regex match; `NAME==x` with no space is a shell
 * assignment of `=x`.
 */
function isAssignment(text: string, keyQuote: string, gap: string, sep: string, valueFrom: number): boolean {
  if (sep === '=>') return keyQuote !== ''
  if (sep !== '=') return true
  const next = text.charAt(valueFrom)
  if (next !== '=' && next !== '~') return true
  return gap === '' && !/^[=~](?:[=\s]|$)/.test(text.slice(valueFrom, valueFrom + 2))
}

function pairSpans(text: string, lines: Lines): DetectedSpan[] {
  const spans: DetectedSpan[] = []
  for (const m of text.matchAll(KEY_RE)) {
    const name = m[2] ?? ''
    // `token?: string` is a TypeScript optional-property annotation.
    if (m[3] === '?' || !isCandidateSecretKey(name) || isPublicKey(name)) continue
    const keyStart = m.index ?? 0
    if (!isAssignment(text, m[1] ?? '', m[4] ?? '', m[5] ?? '', keyStart + m[0].length)) continue
    const pair: KeyedPair = {
      keyStart,
      keyQuote: m[1] ?? '',
      name,
      gap: m[4] ?? '',
      sep: m[5] ?? '',
      valueFrom: keyStart + m[0].length,
    }
    const span = valueSpan(text, lines, pair)
    if (span) spans.push({ start: span[0], end: span[1], kind: 'named-secret', name, rank: KEYED_RANK })
  }
  return spans
}

/** A shell-word argument: quoted, or up to the next unescaped whitespace. */
function argumentSpan(text: string, lines: Lines, from: number): Span | null {
  if (isQuote(text.charAt(from))) return quotedSpan(text, lines, from, 'shell')
  return literalSpan(text, from, shellWordEnd(text, from, lines.endOf(from)), '=')
}

/** Inner span of a shell word, dropping the outer quotes when the whole word is quoted. */
function unquotedWord(text: string, from: number, end: number): Span {
  const first = text.charAt(from)
  if ((first === '"' || first === "'") && end - from >= 2 && text.charAt(end - 1) === first) return [from + 1, end - 1]
  return [from, end]
}

// `--password value`, `--api-key value`: the next argument is the value.
const LONG_FLAG_RE = /(?<![\w-])--([A-Za-z][\w-]{0,63})[ \t]+(?=[^\s-])/g

function longFlagSpans(text: string, lines: Lines): DetectedSpan[] {
  const spans: DetectedSpan[] = []
  for (const m of text.matchAll(LONG_FLAG_RE)) {
    const name = m[1] ?? ''
    if (!isCandidateSecretKey(name) || isPublicKey(name)) continue
    const span = argumentSpan(text, lines, (m.index ?? 0) + m[0].length)
    if (span) spans.push({ start: span[0], end: span[1], kind: 'named-secret', name, rank: KEYED_RANK })
  }
  return spans
}

const CURL_RE = /\bcurl\b/
const CURL_USER_RE = /(?<=[ \t])(?:-u[ \t]*|--user(?:[ \t]+|=))(?=[^\s-])/g
const MYSQL_CLIENT_RE = /\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlsh|mysqlpump|mariadb(?:-dump|-admin)?)\b/
const MYSQL_PASSWORD_RE = /(?<=[ \t])-p(?=\S)/g
const MAX_COMMAND_PREFIX = 4096

function commandPrecedes(text: string, lines: Lines, offset: number, command: RegExp): boolean {
  const start = Math.max(lines.startOf(offset), offset - MAX_COMMAND_PREFIX)
  return command.test(text.slice(start, offset))
}

/** `curl -u user:pass`: the password is what follows the first colon of the argument. */
function curlUserSpans(text: string, lines: Lines): DetectedSpan[] {
  const spans: DetectedSpan[] = []
  for (const m of text.matchAll(CURL_USER_RE)) {
    const from = (m.index ?? 0) + m[0].length
    if (!commandPrecedes(text, lines, m.index ?? 0, CURL_RE)) continue
    const [wordFrom, wordEnd] = unquotedWord(text, from, shellWordEnd(text, from, lines.endOf(from)))
    const colon = text.indexOf(':', wordFrom)
    if (colon === -1 || colon >= wordEnd) continue
    const span = literalSpan(text, colon + 1, wordEnd, '=')
    if (span) spans.push({ start: span[0], end: span[1], kind: 'cli-password', rank: KEYED_RANK })
  }
  return spans
}

/** `mysql -p'secret'` / `-psecret`: the password is attached to the flag. */
function mysqlPasswordSpans(text: string, lines: Lines): DetectedSpan[] {
  const spans: DetectedSpan[] = []
  for (const m of text.matchAll(MYSQL_PASSWORD_RE)) {
    const from = (m.index ?? 0) + 2
    if (!commandPrecedes(text, lines, m.index ?? 0, MYSQL_CLIENT_RE)) continue
    const [wordFrom, wordEnd] = unquotedWord(text, from, shellWordEnd(text, from, lines.endOf(from)))
    const span = literalSpan(text, wordFrom, wordEnd, '=')
    if (span) spans.push({ start: span[0], end: span[1], kind: 'cli-password', rank: KEYED_RANK })
  }
  return spans
}

export function keyedSpans(text: string): DetectedSpan[] {
  const lines = new Lines(text)
  return [
    ...pairSpans(text, lines),
    ...longFlagSpans(text, lines),
    ...curlUserSpans(text, lines),
    ...mysqlPasswordSpans(text, lines),
  ]
}
