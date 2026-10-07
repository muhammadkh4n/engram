/**
 * Scrubs a parsed JSON value (a note's frontmatter, a spool line) member by
 * member, so every string is read in both of its contexts:
 *   - beside its key: only in structured data does a key reliably say what its
 *     value holds, so a member the key rule marks (isSecretMember) becomes its
 *     key's placeholder whatever the value looks like;
 *   - on its own text: escaping a value into a JSON document changes what the
 *     detectors read (a newline becomes `\n`, so a token at a line start
 *     follows a word character; an env or JSON block inside the value is no
 *     longer the whole text), so every other string, and every key, is
 *     scrubbed alone.
 *
 * Fails closed instead of returning a value when two keys of one object scrub
 * to the same text (the members would merge and one value would be lost), or
 * when the value nests deeper than any document this walks.
 */

import { placeholder } from './placeholder.js'
import { scrubSecrets, type ScrubResult, type SecretRedaction } from './scrub-secrets.js'
import { isSecretMember } from './structured-text.js'

/** Object keys (as scrubbed) and array indexes from the root to a member. */
export type StructuredPath = ReadonlyArray<string | number>

export interface StructuredRedaction extends SecretRedaction {
  path: StructuredPath
  /** Whether the secret was in the member's key or in its value. */
  part: 'key' | 'value'
}

export type ScrubStructuredResult =
  | { ok: true; value: unknown; redactions: StructuredRedaction[] }
  | { ok: false; reason: 'key-collision' | 'too-deep' }

type Scrub = (text: string) => Promise<ScrubResult>
type Failure = 'key-collision' | 'too-deep'

// Frontmatter and capture events nest a few levels; the bound keeps a
// pathological input from exhausting the stack, and fails closed past it.
const MAX_DEPTH = 64

class WalkRefused extends Error {
  constructor(readonly reason: Failure) {
    super(reason)
  }
}

interface Walk {
  scrub: Scrub
  redactions: StructuredRedaction[]
}

async function scrubText(text: string, path: StructuredPath, part: 'key' | 'value', walk: Walk): Promise<string> {
  const result = await walk.scrub(text)
  for (const r of result.redactions) walk.redactions.push({ ...r, path, part })
  return result.text
}

async function scrubKey(key: string, path: StructuredPath, walk: Walk): Promise<string> {
  const keyWalk: Walk = { scrub: walk.scrub, redactions: [] }
  const scrubbed = await scrubText(key, path, 'key', keyWalk)
  // The path names the key as stored, so a masked key never comes back through it.
  for (const r of keyWalk.redactions) walk.redactions.push({ ...r, path: [...path, scrubbed] })
  return scrubbed
}

async function walkObject(value: object, path: StructuredPath, depth: number, walk: Walk): Promise<Record<string, unknown>> {
  const entries: Array<[string, unknown]> = []
  const keys = new Set<string>()
  for (const [key, member] of Object.entries(value)) {
    const stored = await scrubKey(key, path, walk)
    if (keys.has(stored)) throw new WalkRefused('key-collision')
    keys.add(stored)
    const memberPath = [...path, stored]
    if (isSecretMember(key, member)) {
      walk.redactions.push({ kind: 'named-secret', name: stored, path: memberPath, part: 'value' })
      entries.push([stored, placeholder(stored)])
    } else {
      entries.push([stored, await walkValue(member, memberPath, depth + 1, walk)])
    }
  }
  // fromEntries defines each key as an own property, so `__proto__` stays data.
  return Object.fromEntries(entries)
}

async function walkValue(value: unknown, path: StructuredPath, depth: number, walk: Walk): Promise<unknown> {
  if (depth > MAX_DEPTH) throw new WalkRefused('too-deep')
  if (typeof value === 'string') return scrubText(value, path, 'value', walk)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const [i, item] of value.entries()) out.push(await walkValue(item, [...path, i], depth + 1, walk))
    return out
  }
  if (value !== null && typeof value === 'object') return walkObject(value, path, depth, walk)
  return value
}

export async function scrubStructured(value: unknown, scrub: Scrub = scrubSecrets): Promise<ScrubStructuredResult> {
  const walk: Walk = { scrub, redactions: [] }
  try {
    return { ok: true, value: await walkValue(value, [], 0, walk), redactions: walk.redactions }
  } catch (err) {
    if (err instanceof WalkRefused) return { ok: false, reason: err.reason }
    throw err
  }
}
