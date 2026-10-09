/**
 * Key names decide only where the text is structured data, because only there
 * does a key reliably say what its value holds. A text that parses whole as
 * JSON, or whose every non-empty line is a `KEY=VALUE` assignment (an env
 * file, `export` lines), is read as that structure, and the value under each
 * credential-named key is redacted whatever it looks like. Free text never goes
 * through this rule: there `password:` is as often prose, a type annotation
 * or a lookup as it is a credential.
 */

import { isOnlyPlaceholders } from './placeholder.js'
import { isCredentialKey, isPublicKey, isPublishableValue } from './secret-keys.js'
import type { DetectedSpan } from './secretlint-spans.js'
import { isShellReference, quotedValueEnd, shellWordEnd } from './value-extent.js'

/** A key name outranks format rules when two equally wide spans overlap. */
export const STRUCTURED_RANK = 0

// Structured blobs past this size are scanned for known values and formats only.
const MAX_STRUCTURED_LENGTH = 1_000_000

// A sops-encrypted value is ciphertext, safe to store; its key still names a secret.
const SOPS_ENCRYPTED_RE = /^ENC\[[A-Za-z0-9_]+,data:[^\]]*\]$/

/**
 * Whether a value stored under this key in structured data is a credential:
 * the key names a credential term (isCredentialKey), the key is not public by
 * design, and the value is a literal (not empty, not a shell reference, not
 * already redacted).
 */
export function isSecretUnderKey(name: string, value: string, isLiteralQuoted = false): boolean {
  if (!isCredentialKey(name) || isPublicKey(name)) return false
  const trimmed = value.trim()
  if (trimmed === '' || isOnlyPlaceholders(value) || isPublishableValue(trimmed) || SOPS_ENCRYPTED_RE.test(trimmed)) return false
  return isLiteralQuoted || !isShellReference(trimmed)
}

/**
 * Whether an object member is a credential by its key: a string, or a number
 * (a JSON number token reads as the same literal), under a key that
 * isSecretUnderKey accepts. Every reader of structured data asks this one rule.
 */
export function isSecretMember(key: string, value: unknown): boolean {
  if (typeof value === 'string') return isSecretUnderKey(key, value)
  return typeof value === 'number' && isSecretUnderKey(key, String(value))
}

function span(start: number, end: number, name: string): DetectedSpan {
  return { start, end, kind: 'named-secret', name, rank: STRUCTURED_RANK }
}

// Tokens of text JSON.parse has already accepted.
const JSON_TOKEN_RE = /\s+|"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,"]+/y
const JSON_NUMBER_RE = /^-?\d/

interface Frame {
  isObject: boolean
  expectsKey: boolean
  key: string
}

function jsonValueSpan(frame: Frame | undefined, token: string, start: number): DetectedSpan | null {
  if (!frame?.isObject) return null
  if (token.startsWith('"')) {
    return isSecretMember(frame.key, JSON.parse(token)) ? span(start + 1, start + token.length - 1, frame.key) : null
  }
  return JSON_NUMBER_RE.test(token) && isSecretMember(frame.key, Number(token)) ? span(start, start + token.length, frame.key) : null
}

function jsonSpans(text: string): DetectedSpan[] {
  const spans: DetectedSpan[] = []
  const stack: Frame[] = []
  JSON_TOKEN_RE.lastIndex = 0
  for (let m = JSON_TOKEN_RE.exec(text); m !== null && m[0] !== ''; m = JSON_TOKEN_RE.exec(text)) {
    const token = m[0]
    const top = stack[stack.length - 1]
    if (token === '{' || token === '[') stack.push({ isObject: token === '{', expectsKey: token === '{', key: '' })
    else if (token === '}' || token === ']') stack.pop()
    else if (token === ':' && top) top.expectsKey = false
    else if (token === ',' && top) top.expectsKey = top.isObject
    else if (/^\s/.test(token)) continue
    else if (top?.expectsKey && token.startsWith('"')) top.key = JSON.parse(token) as string
    else {
      const found = jsonValueSpan(top, token, m.index)
      if (found) spans.push(found)
    }
  }
  return spans
}

function parsesAsJson(text: string): boolean {
  const first = text.trimStart().charAt(0)
  if (first !== '{' && first !== '[') return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const ENV_LINE_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)=/
const COMMENT_LINE_RE = /^[ \t]*#/
// `` TOKEN=`cat ~/.token` ``: the shell runs the command; the value is its output.
const COMMAND_SUBSTITUTION_RE = /^`[^`]*`$/

interface Line {
  start: number
  text: string
}

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (const raw of text.split('\n')) {
    lines.push({ start, text: raw.replace(/\r$/, '') })
    start += raw.length + 1
  }
  return lines
}

interface EnvAssignment {
  name: string
  /** Value range within the line; empty when the line assigns nothing. */
  from: number
  end: number
  isSingleQuoted: boolean
}

/**
 * Parses one env assignment line with shell word rules, which dotenv shares
 * for quoted values: the value is one shell word (quotes, escapes and
 * `'it'\''s'` concatenation included), so `PGPASSWORD=x psql -h db` assigns
 * `x` and keeps the command. `NAME= next` assigns the empty string.
 */
function parseEnvLine(text: string): EnvAssignment | null {
  const m = ENV_LINE_RE.exec(text)
  if (!m) return null
  const name = m[1] ?? ''
  const from = m[0].length
  if (from >= text.length || /\s/.test(text.charAt(from))) return { name, from, end: from, isSingleQuoted: false }
  const end = shellWordEnd(text, from, text.length)
  const q = text.charAt(from)
  const isWhollyQuoted = (q === '"' || q === "'") && end - from >= 2 && quotedValueEnd(text, from, end) === end - 1
  if (!isWhollyQuoted) return { name, from, end, isSingleQuoted: false }
  return { name, from: from + 1, end: end - 1, isSingleQuoted: q === "'" }
}

function envAssignments(lines: Line[]): Array<{ line: Line; assignment: EnvAssignment }> | null {
  const found: Array<{ line: Line; assignment: EnvAssignment }> = []
  for (const line of lines) {
    if (line.text.trim() === '' || COMMENT_LINE_RE.test(line.text)) continue
    const assignment = parseEnvLine(line.text)
    if (!assignment) return null
    found.push({ line, assignment })
  }
  return found.length > 0 ? found : null
}

/** A whole backtick value is a command substitution; its output is not in the text. */
function envSpans(lines: Line[]): DetectedSpan[] {
  return (envAssignments(lines) ?? []).flatMap(({ line, assignment: a }) => {
    const value = line.text.slice(a.from, a.end)
    if (COMMAND_SUBSTITUTION_RE.test(value) || !isSecretUnderKey(a.name, value, a.isSingleQuoted)) return []
    return [span(line.start + a.from, line.start + a.end, a.name)]
  })
}

/** Values under secret-named keys when the whole text is JSON or an env block; nothing otherwise. */
export function structuredSpans(text: string): DetectedSpan[] {
  if (text.length > MAX_STRUCTURED_LENGTH) return []
  if (parsesAsJson(text)) return jsonSpans(text)
  return envSpans(linesOf(text))
}
