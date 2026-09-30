/**
 * Redacts credential values from free text before it is stored, embedded or
 * sent to a summarisation model. Key names are kept so the memory still says
 * *which* secret was involved; only the value is replaced.
 *
 * Only rules that are right whenever they fire redact:
 *   - values registered from this machine's secret files, in any spelling (secret-registry.ts)
 *   - known token formats, private keys and connection strings (secretlint)
 *   - self-identifying formats: PEM private-key blocks with a base64 body
 *     (including truncated ones), JWTs, OpenRouter keys, Anthropic
 *     OAuth/admin tokens, the credential of an `Authorization: Bearer|Basic`
 *     header and URL userinfo passwords
 *   - values under credential-named keys, only when the whole text is
 *     structured data (JSON, an env block; see structured-text.ts)
 * Guesses from free-text key names and entropy only flag review candidates
 * (secret-candidates.ts) and never change text.
 *
 * Overlapping spans collapse into one covering both, labelled by the widest
 * (ties by rank, below). Spans are replaced right to left so earlier offsets
 * stay valid.
 *
 * Every placeholder has the form `[REDACTED:<label>]` and no rule matches a
 * placeholder, so scrubbing already-scrubbed text is a no-op.
 */

import { placeholder } from './placeholder.js'
import { defaultSecretRegistry } from './secret-registry.js'
import { secretlintSpans } from './secretlint-spans.js'
import type { DetectedSpan } from './secretlint-spans.js'
import { STRUCTURED_RANK, structuredSpans } from './structured-text.js'
import { DOC_PLACEHOLDER_RE, urlPasswords } from './url-userinfo.js'

export interface SecretRedaction {
  kind: string
  name?: string
}

export interface ScrubResult {
  text: string
  redactions: SecretRedaction[]
}

/** One redaction and the range of the original text it replaces. */
export interface DetectedSecret extends SecretRedaction {
  start: number
  end: number
}

// Equally wide overlapping spans take the label of the lowest rank: a known
// value first (certain, and named by its source), then the key name, then our
// format rules, then secretlint.
const KNOWN_VALUE_RANK = STRUCTURED_RANK - 1
const OWN_RANK = STRUCTURED_RANK + 1

function knownValueSpans(text: string): DetectedSpan[] {
  return defaultSecretRegistry()
    .findKnownValues(text)
    .map(({ start, end, name }) => ({ start, end, kind: 'known', name, rank: KNOWN_VALUE_RANK }))
}

// Also covers blocks the secretlint rule leaves out: truncated ones (no END
// line), short bodies, and types such as ENCRYPTED PRIVATE KEY. A header is
// key material only when base64 body lines follow it; a bare header is prose
// ("the file must start with -----BEGIN … PRIVATE KEY-----").
const PEM_BEGIN_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g
const PEM_END = String.raw`-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----`
// A line break as written: real, or escaped inside a (possibly nested) JSON
// or JS string. Body lines may be indented, as in a YAML block scalar.
const PEM_LINE_BREAK = String.raw`(?:\r?\n|\\+r\\+n|\\+n)[ \t]*`
// Env files often carry the whole block on one line, space-separated.
const PEM_BREAK = String.raw`(?:${PEM_LINE_BREAK}|[ \t]+)`
// RFC 1421 encapsulated headers of a legacy encrypted key, then a blank line.
const PEM_HEADERS_RE = new RegExp(String.raw`(?:${PEM_LINE_BREAK}(?:Proc-Type|DEK-Info):[^\r\n\\]*)+(?:${PEM_LINE_BREAK}(?=${PEM_LINE_BREAK}))?`, 'y')
// Body lines are 64 (PEM) or 70 (OpenSSH) characters; the first one must be a full line.
const PEM_FULL_LINE_RE = new RegExp(String.raw`${PEM_BREAK}[A-Za-z0-9+/=]{40,}`, 'y')
// The shorter last line: before the END line, or where a cut-off block ends
// with the text or its string. A short line followed by more prose is prose.
const PEM_SHORT_LINE_RE = new RegExp(String.raw`${PEM_BREAK}[A-Za-z0-9+/]+={0,2}(?=(?:${PEM_BREAK})?${PEM_END}|\s*$|["'\x60\\])`, 'y')
const PEM_END_RE = new RegExp(String.raw`(?:${PEM_BREAK})?${PEM_END}`, 'y')

/** Advances past a sticky match at `from`, or stays put. */
function skip(re: RegExp, text: string, from: number): number {
  re.lastIndex = from
  return re.exec(text) ? re.lastIndex : from
}

function pemBlockEnd(text: string, headerEnd: number): number | null {
  const bodyStart = skip(PEM_HEADERS_RE, text, headerEnd)
  let end = skip(PEM_FULL_LINE_RE, text, bodyStart)
  if (end === bodyStart) return null
  for (let next = skip(PEM_FULL_LINE_RE, text, end); next !== end; next = skip(PEM_FULL_LINE_RE, text, end)) end = next
  end = skip(PEM_SHORT_LINE_RE, text, end)
  return skip(PEM_END_RE, text, end)
}

function pemSpans(text: string): DetectedSpan[] {
  const spans: DetectedSpan[] = []
  for (const m of text.matchAll(PEM_BEGIN_RE)) {
    const start = m.index ?? 0
    const end = pemBlockEnd(text, start + m[0].length)
    if (end !== null) spans.push({ start, end, kind: 'private-key', rank: OWN_RANK })
  }
  return spans
}

function urlPasswordSpans(text: string): DetectedSpan[] {
  return urlPasswords(text, 0, text.length)
    .filter((p) => !p.isPlaceholder)
    .map(({ start, end, kind }) => ({ start, end, kind, rank: OWN_RANK }))
}

// Formats the secretlint rule set has no rule for.
const KNOWN_FORMATS: ReadonlyArray<readonly [string, RegExp]> = [
  // secretlint matches only `sk-ant-api0N-` API keys; OAuth and admin tokens
  // (`sk-ant-oat01-`, `sk-ant-admin01-`) carry the same access.
  ['anthropic-key', /(?<![\w-])sk-ant-(?!api\d)[a-z]+\d*-[A-Za-z0-9_-]{20,}/g],
  ['openrouter-key', /(?<![\w-])sk-or-v1-[A-Za-z0-9]{20,}/g],
  ['jwt', /(?<![\w-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g],
]

function knownFormatSpans(text: string): DetectedSpan[] {
  return KNOWN_FORMATS.flatMap(([kind, re]) =>
    [...text.matchAll(re)].map((m) => {
      const start = m.index ?? 0
      return { start, end: start + m[0].length, kind, rank: OWN_RANK }
    }),
  )
}

// `Authorization: Bearer <token>` in a raw header, a curl `-H "…"`, JSON or
// a JS object; `Proxy-Authorization` carries the same credential. Only the
// RFC 7235 token68 credential after the scheme is redacted, never the rest
// of the line, and only when it is at least 8 characters and not a plain
// word: "Authorization: Bearer tokens must be rotated" and "Authorization:
// Basic authentication is off" are prose. A reference (`$TOKEN`, `${token}`,
// `' + token`) or a placeholder (`<token>`) starts with a character token68
// does not allow, so it yields no credential.
const AUTH_CREDENTIAL_RE = /(?<![\w-])(?:proxy-)?authorization["'`]?[ \t]*[:=][ \t]*["'`]?(?:bearer|basic)[ \t]+([A-Za-z0-9\-._~+/]+=*)/gi
const MIN_CREDENTIAL_LENGTH = 8
const PLAIN_WORD_RE = /^[A-Za-z][a-z]*$/

function authorizationSpans(text: string): DetectedSpan[] {
  const spans: DetectedSpan[] = []
  for (const m of text.matchAll(AUTH_CREDENTIAL_RE)) {
    const token = m[1] ?? ''
    if (token.length < MIN_CREDENTIAL_LENGTH || PLAIN_WORD_RE.test(token) || DOC_PLACEHOLDER_RE.test(token)) continue
    const end = (m.index ?? 0) + m[0].length
    spans.push({ start: end - token.length, end, kind: 'authorization', rank: OWN_RANK })
  }
  return spans
}

/**
 * secretlint reports a connection string or basic-auth URL as the whole URL;
 * only its userinfo password is the secret, so such a span narrows to it, and
 * is dropped when that password is already a placeholder or a doc placeholder.
 */
function narrowUrlSpans(text: string, spans: DetectedSpan[]): DetectedSpan[] {
  return spans.flatMap((span) => {
    const passwords = urlPasswords(text, span.start, span.end)
    if (passwords.length === 0) return [span]
    return passwords
      .filter((p) => !p.isPlaceholder)
      .map(({ start, end }) => ({ ...span, start, end }))
  })
}

function width(span: DetectedSpan): number {
  return span.end - span.start
}

function outranks(candidate: DetectedSpan, current: DetectedSpan): boolean {
  if (width(candidate) !== width(current)) return width(candidate) > width(current)
  return candidate.rank < current.rank
}

interface MergedSpan {
  start: number
  end: number
  label: DetectedSpan
}

/** Overlapping spans become one span covering all of them, so no part of any detected value survives. */
function mergeSpans(spans: DetectedSpan[]): MergedSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank)
  const merged: MergedSpan[] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (!last || span.start >= last.end) {
      merged.push({ start: span.start, end: span.end, label: span })
      continue
    }
    merged[merged.length - 1] = {
      start: last.start,
      end: Math.max(last.end, span.end),
      label: outranks(span, last.label) ? span : last.label,
    }
  }
  return merged
}

/** Detect mode: the spans scrubSecrets would replace, in text order, without replacing them. */
export async function detectSecrets(text: string): Promise<DetectedSecret[]> {
  if (text === '') return []
  const spans = [
    ...knownValueSpans(text),
    ...narrowUrlSpans(text, await secretlintSpans(text)),
    ...structuredSpans(text),
    ...pemSpans(text),
    ...urlPasswordSpans(text),
    ...authorizationSpans(text),
    ...knownFormatSpans(text),
  ]
  return mergeSpans(spans).map(({ start, end, label }) =>
    label.name !== undefined ? { start, end, kind: label.kind, name: label.name } : { start, end, kind: label.kind },
  )
}

export async function scrubSecrets(text: string): Promise<ScrubResult> {
  const detected = await detectSecrets(text)
  let out = text
  for (let i = detected.length - 1; i >= 0; i--) {
    const { start, end, kind, name } = detected[i]!
    out = out.slice(0, start) + placeholder(name ?? kind) + out.slice(end)
  }
  const redactions: SecretRedaction[] = detected.map(({ kind, name }) => (name !== undefined ? { kind, name } : { kind }))
  return { text: out, redactions }
}
