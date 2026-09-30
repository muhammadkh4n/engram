/**
 * Detect-only heuristics for credentials in free text: values after
 * secret-named keys (`password: …`, `API_KEY=…`), CLI password arguments and
 * high-entropy values after `=` / `:`. On real transcripts these are right
 * far too rarely to redact on their own — `password:` is as often prose, a
 * type or a lookup — so they never change text. They feed a review list: a
 * person reads the flagged spans and registers the real secrets, which are
 * then masked everywhere as known values.
 */

import { keyedSpans } from './keyed-secrets.js'
import type { DetectedSpan } from './secretlint-spans.js'

export interface SecretCandidate {
  kind: string
  /** The key the value was assigned to, when a key flagged it. */
  name?: string
  start: number
  end: number
}

const HIGH_ENTROPY_RANK = 3
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
 * Spans that may hold a credential, in text order. Where two overlap only the
 * first (a keyed span before an entropy guess) is kept. Never modifies text.
 */
export function findSecretCandidates(text: string): SecretCandidate[] {
  if (text === '') return []
  const spans = [...keyedSpans(text), ...highEntropySpans(text)].sort(
    (a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end,
  )
  const kept: SecretCandidate[] = []
  for (const s of spans) {
    const last = kept[kept.length - 1]
    if (last && s.start < last.end) continue
    kept.push(s.name !== undefined ? { kind: s.kind, name: s.name, start: s.start, end: s.end } : { kind: s.kind, start: s.start, end: s.end })
  }
  return kept
}
