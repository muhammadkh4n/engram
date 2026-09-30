/**
 * Redacts credential values from free text before it is stored, embedded or
 * sent to a summarisation model. Key names are kept so the memory still says
 * *which* secret was involved; only the value is replaced.
 *
 * Every rule reads the original text and reports spans:
 *   - values registered from this machine's secret files, in any spelling (secret-registry.ts)
 *   - known token formats, private keys and connection strings (secretlint)
 *   - values assigned to secret-named keys and CLI password arguments (keyed-secrets.ts)
 *   - PEM private-key blocks, including truncated ones
 *   - passwords inside URL userinfo, for any scheme
 *   - formats secretlint lacks (JWTs, OpenRouter keys, Anthropic OAuth/admin tokens)
 *   - high-entropy values after `=` / `:` whose key name gave no signal
 * Overlapping spans collapse into one covering both, labelled by the widest
 * (ties by rank, below). Spans are replaced right to left so earlier offsets
 * stay valid.
 *
 * Every placeholder has the form `[REDACTED:<label>]` and no rule matches a
 * placeholder, so scrubbing already-scrubbed text is a no-op.
 */

import { KEYED_RANK, keyedSpans } from './keyed-secrets.js'
import { PLACEHOLDER_PREFIX, placeholder } from './placeholder.js'
import { defaultSecretRegistry } from './secret-registry.js'
import { SECRETLINT_RANK, secretlintSpans } from './secretlint-spans.js'
import type { DetectedSpan } from './secretlint-spans.js'
import { isShellReference } from './value-extent.js'

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

// Documentation placeholders inside a URL: `...`, `<pwd>`, `xxxx`, `****`.
// `<` and `>` cannot appear unencoded in a URL, so `<pwd>` is never a password.
const DOC_PLACEHOLDER_RE = /(?:\.\.\.|…)$|^<[^>]*>$|^(?:x{3,}|\*{3,})$/i

// Equally wide overlapping spans take the label of the lowest rank: a known
// value first (certain, and named by its source), then the key name, then our
// format rules, then secretlint, then the entropy guess.
const KNOWN_VALUE_RANK = KEYED_RANK - 1
const OWN_RANK = KEYED_RANK + 1

function knownValueSpans(text: string): DetectedSpan[] {
  return defaultSecretRegistry()
    .findKnownValues(text)
    .map(({ start, end, name }) => ({ start, end, kind: 'known', name, rank: KNOWN_VALUE_RANK }))
}
const HIGH_ENTROPY_RANK = SECRETLINT_RANK + 1

// Also covers blocks the secretlint rule leaves out: truncated ones (no END
// line), short bodies, and types such as ENCRYPTED PRIVATE KEY.
const PEM_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$(?![\s\S]))/g

function pemSpans(text: string): DetectedSpan[] {
  return [...text.matchAll(PEM_RE)].map((m) => {
    const start = m.index ?? 0
    return { start, end: start + m[0].length, kind: 'private-key', rank: OWN_RANK }
  })
}

// The authority runs from `//` to the first `/`, `?`, `#` or whitespace; its
// userinfo ends at the last `@` and the password follows the first `:`.
// Characters a password may contain are not restricted: URL syntax alone
// delimits it. Authorities are length-bounded to keep the scan linear.
const URL_AUTHORITY_RE = /\b([a-z][a-z0-9+.-]{0,31}):\/\/([^\s/?#]{1,2048})/gi

function urlKind(scheme: string): string {
  const s = scheme.toLowerCase()
  if (s === 'postgres' || s === 'postgresql') return 'postgres-url'
  if (s === 'http' || s === 'https') return 'http-url'
  return 'url-password'
}

interface UrlPassword {
  start: number
  end: number
  kind: string
  isPlaceholder: boolean
}

/**
 * A URL wrapped in quotes (`'postgres://u:p@h'`) ends at the matching quote,
 * so the authority cannot run on into the text after it.
 */
function authorityWithinQuotes(text: string, schemeStart: number, authority: string): string {
  const quote = text.charAt(schemeStart - 1)
  if (quote !== '"' && quote !== "'" && quote !== '`') return authority
  const close = authority.indexOf(quote)
  return close === -1 ? authority : authority.slice(0, close)
}

function urlPasswords(text: string, from: number, to: number): UrlPassword[] {
  const found: UrlPassword[] = []
  for (const m of text.slice(from, to).matchAll(URL_AUTHORITY_RE)) {
    const schemeStart = from + (m.index ?? 0)
    const authorityStart = schemeStart + (m[1] ?? '').length + 3
    const authority = authorityWithinQuotes(text, schemeStart, m[2] ?? '')
    const at = authority.lastIndexOf('@')
    const colon = at === -1 ? -1 : authority.indexOf(':')
    if (colon === -1 || colon > at) continue
    const password = authority.slice(colon + 1, at)
    if (password === '') continue
    const isPlaceholder =
      password.startsWith(PLACEHOLDER_PREFIX) || DOC_PLACEHOLDER_RE.test(password) || isShellReference(password)
    found.push({ start: authorityStart + colon + 1, end: authorityStart + at, kind: urlKind(m[1] ?? ''), isPlaceholder })
  }
  return found
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

const HIGH_ENTROPY_MIN_LENGTH = 32
const HIGH_ENTROPY_MAX_LENGTH = 1024
const HIGH_ENTROPY_MIN_BITS = 4.0
// A token directly after `=` / `:` (optionally quoted). A leading `/` is a URL
// or path, and `.` is excluded so filenames and hostnames never qualify.
const HIGH_ENTROPY_RE = new RegExp(
  String.raw`(?<=[=:][ \t]*["']?)(?<!\[REDACTED:)(?!\/)([A-Za-z0-9+\/_-]{${HIGH_ENTROPY_MIN_LENGTH},${HIGH_ENTROPY_MAX_LENGTH}}={0,2})(?=$|[\s"',;)}\]])`,
  'gm',
)

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) {
    const p = n / s.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * Requires upper case, lower case and digits together: hex digests, commit
 * shas and UUIDs are single-case and never qualify, random base64/base62
 * secrets virtually always do.
 */
function looksRandom(token: string): boolean {
  const mixed = /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token)
  return mixed && shannonEntropy(token) >= HIGH_ENTROPY_MIN_BITS
}

function highEntropySpans(text: string): DetectedSpan[] {
  return [...text.matchAll(HIGH_ENTROPY_RE)]
    .filter((m) => looksRandom(m[0]))
    .map((m) => {
      const start = m.index ?? 0
      return { start, end: start + m[0].length, kind: 'high-entropy', rank: HIGH_ENTROPY_RANK }
    })
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
    ...keyedSpans(text),
    ...pemSpans(text),
    ...urlPasswordSpans(text),
    ...knownFormatSpans(text),
    ...highEntropySpans(text),
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
