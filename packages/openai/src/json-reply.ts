/**
 * Reads one JSON value out of a chat-model reply.
 *
 * Models asked for "only JSON" still return it in several shapes: bare, inside
 * a ```json or bare ``` fence, a fence with prose before or after it, or a bare
 * object/array in the middle of prose. Every reply goes through the same three
 * steps, and the first candidate that parses (and that `accept` takes) wins:
 *
 *   1. the trimmed reply as a whole;
 *   2. each fenced block, in order of appearance (markers pair up in order);
 *   3. each balanced `{…}` / `[…]` span, in order of its opening bracket, found
 *      by a scanner that skips JSON strings and their escapes, so brackets and
 *      backticks inside string values never end a span.
 *
 * Step 1 runs first so a valid reply whose string values contain fences or
 * brackets is never cut. Nothing parses → throws, naming why.
 */
export function extractJsonReply(raw: string, accept: (value: unknown) => boolean = () => true): unknown {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new Error('empty reply, no JSON value')

  for (const candidate of candidates(trimmed)) {
    const parsed = tryParse(candidate)
    if (parsed.ok && accept(parsed.value)) return parsed.value
  }
  throw new Error(
    `no JSON value in reply (${trimmed.length} chars): not JSON as a whole, no fenced block parses, no balanced {…}/[…] span parses`,
  )
}

function* candidates(text: string): Generator<string> {
  yield text
  yield* fencedBlocks(text)
  yield* balancedSpans(text)
}

const FENCE = '```'

function* fencedBlocks(text: string): Generator<string> {
  let open = text.indexOf(FENCE)
  while (open !== -1) {
    const close = text.indexOf(FENCE, open + FENCE.length)
    if (close === -1) return
    yield stripInfoString(text.slice(open + FENCE.length, close))
    open = text.indexOf(FENCE, close + FENCE.length)
  }
}

/** Drops a fence's info string: a first line with no JSON opener on it
 *  (```json, ```JSON, ```javascript), or a `json` word glued to the value. */
function stripInfoString(inner: string): string {
  const newline = inner.indexOf('\n')
  if (newline !== -1) {
    const firstLine = inner.slice(0, newline)
    if (!/[{[]/.test(firstLine)) return inner.slice(newline + 1)
  }
  return inner.replace(/^\s*json(?=\s*[{[])/i, '')
}

function* balancedSpans(text: string): Generator<string> {
  for (let start = 0; start < text.length; start++) {
    const ch = text[start]
    if (ch !== '{' && ch !== '[') continue
    const end = balancedEnd(text, start)
    if (end !== -1) yield text.slice(start, end + 1)
  }
}

const CLOSER: Record<string, string> = { '{': '}', '[': ']' }

/** Index of the bracket closing the one at `start`, or -1 when the brackets
 *  mismatch or never close. Characters inside JSON strings are skipped. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = []
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{' || ch === '[') {
      stack.push(CLOSER[ch]!)
    } else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}
