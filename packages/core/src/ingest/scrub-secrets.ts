/**
 * Redacts credential values from free text before it is stored, embedded or
 * sent to a summarisation model. Key names are kept so the memory still says
 * *which* secret was involved; only the value is replaced.
 *
 * Only rules that are right whenever they fire redact:
 *   - values registered from this machine's secret files, in any spelling (secret-registry.ts)
 *   - known token formats, private keys and connection strings (secretlint)
 *   - self-identifying formats: PEM private-key blocks (including truncated
 *     ones), JWTs, OpenRouter keys, Anthropic OAuth/admin tokens,
 *     `Authorization: Bearer|Basic` header values and URL userinfo passwords
 *   - values under secret-named keys, only when the whole text is structured
 *     data (JSON, an env block; see structured-text.ts)
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

import { PLACEHOLDER_PREFIX, placeholder } from './placeholder.js'
import { defaultSecretRegistry } from './secret-registry.js'
import { secretlintSpans } from './secretlint-spans.js'
import type { DetectedSpan } from './secretlint-spans.js'
import { STRUCTURED_RANK, structuredSpans } from './structured-text.js'
import { DOC_PLACEHOLDER_RE, urlPasswords } from './url-userinfo.js'
import { Lines, isQuote, isShellReference, quotedValueEnd, shellWordEnd } from './value-extent.js'

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
// line), short bodies, and types such as ENCRYPTED PRIVATE KEY.
const PEM_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$(?![\s\S]))/g

function pemSpans(text: string): DetectedSpan[] {
  return [...text.matchAll(PEM_RE)].map((m) => {
    const start = m.index ?? 0
    return { start, end: start + m[0].length, kind: 'private-key', rank: OWN_RANK }
  })
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
// a JS object. The token's extent comes from the syntax around the header:
// the string it sits in, the quoted value, the line of a raw header, or one
// shell word mid-line. `Proxy-Authorization` carries the same credential.
const AUTH_HEADER_RE = /(?<![\w-])(?:proxy-)?authorization(["'`]?)[ \t]*[:=][ \t]*/gi
const AUTH_SCHEME_RE = /^(?:bearer|basic)[ \t]+/i
const LINE_LEADING_RE = /^[ \t]*(?:[-*+>][ \t]*)?$/

type Range = readonly [number, number]

function quotedContent(text: string, open: number, lineEnd: number): Range {
  const close = quotedValueEnd(text, open, lineEnd)
  return [open + 1, close === -1 ? lineEnd : close]
}

function authValueRange(text: string, lines: Lines, nameStart: number, keyQuote: string, from: number): Range {
  const lineEnd = lines.endOf(from)
  if (isQuote(text.charAt(from))) return quotedContent(text, from, lineEnd)
  const before = text.charAt(nameStart - 1)
  if (!keyQuote && isQuote(before)) return [from, quotedContent(text, nameStart - 1, lineEnd)[1]]
  if (LINE_LEADING_RE.test(text.slice(lines.startOf(nameStart), nameStart))) return [from, lineEnd]
  const scheme = AUTH_SCHEME_RE.exec(text.slice(from, lineEnd))
  return [from, shellWordEnd(text, from + (scheme?.[0].length ?? 0), lineEnd)]
}

/** In a JS template (`` `Bearer ${token}` ``) `${…}` is interpolation, elsewhere it is literal text. */
function isReferenceOrPlaceholder(token: string, isTemplate: boolean): boolean {
  return (
    token === '' ||
    (isTemplate && token.includes('${')) ||
    isShellReference(token) ||
    token.startsWith(PLACEHOLDER_PREFIX) ||
    DOC_PLACEHOLDER_RE.test(token)
  )
}

function authorizationSpans(text: string): DetectedSpan[] {
  const lines = new Lines(text)
  const spans: DetectedSpan[] = []
  for (const m of text.matchAll(AUTH_HEADER_RE)) {
    const nameStart = m.index ?? 0
    const valueFrom = nameStart + m[0].length
    const isTemplate = text.charAt(valueFrom) === '`' || text.charAt(nameStart - 1) === '`'
    const [from, end] = authValueRange(text, lines, nameStart, m[1] ?? '', valueFrom)
    const value = text.slice(from, end)
    const scheme = AUTH_SCHEME_RE.exec(value)
    if (!scheme) continue
    const token = value.slice(scheme[0].length).trimEnd()
    if (isReferenceOrPlaceholder(token.trim(), isTemplate)) continue
    const start = from + scheme[0].length
    spans.push({ start, end: start + token.length, kind: 'authorization', rank: OWN_RANK })
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
