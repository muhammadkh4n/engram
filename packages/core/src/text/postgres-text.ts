/**
 * Text PostgreSQL cannot hold. `text` and `jsonb` refuse U+0000, and a UTF-16
 * surrogate without its partner has no UTF-8 encoding, so either one makes
 * the whole statement fail. Both become U+FFFD here; a valid surrogate pair
 * is kept.
 *
 * Paths name keys only when a key is an identifier; any other key may be user
 * text (an answer map is keyed by question text), so it is written by its
 * position among the object's keys, `[#n]`. A path never carries a value.
 */

const REPLACEMENT = '�'
const UNSAFE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const UNSAFE_TEST = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const PRINTABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Two keys of one object are equal once their unsafe text is replaced; `path` names the object. */
export class PostgresTextKeyCollision extends Error {
  readonly path: string

  constructor(path: string) {
    super(`${path || 'the value'} has keys that are equal once U+0000 and unpaired surrogates become U+FFFD`)
    this.name = 'PostgresTextKeyCollision'
    this.path = path
  }
}

function keyPath(base: string, key: string, position: number): string {
  if (PRINTABLE_KEY.test(key)) return base ? `${base}.${key}` : key
  return `${base}[#${position}]`
}

function replaceUnsafe(text: string): string {
  return UNSAFE_TEST.test(text) ? text.replace(UNSAFE, REPLACEMENT) : text
}

function copy(value: unknown, path: string): unknown {
  if (typeof value === 'string') return replaceUnsafe(value)
  if (Array.isArray(value)) return value.map((v, i) => copy(v, `${path}[${i}]`))
  if (value === null || typeof value !== 'object') return value
  const seen = new Set<string>()
  const entries = Object.keys(value).map((key, i): [string, unknown] => {
    const safeKey = replaceUnsafe(key)
    if (seen.has(safeKey)) throw new PostgresTextKeyCollision(path)
    seen.add(safeKey)
    return [safeKey, copy((value as Record<string, unknown>)[key], keyPath(path, key, i))]
  })
  // fromEntries defines own properties, so a `__proto__` key stays data.
  return Object.fromEntries(entries)
}

/**
 * A copy of a JSON value with each U+0000 and each unpaired surrogate replaced
 * by U+FFFD in every string and object key. Throws PostgresTextKeyCollision
 * when two keys of one object become equal, since the copy would lose one.
 */
export function toPostgresText<T>(value: T): T {
  return copy(value, '') as T
}

function find(value: unknown, path: string): string | null {
  if (typeof value === 'string') return UNSAFE_TEST.test(value) ? path : null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = find(value[i], `${path}[${i}]`)
      if (found !== null) return found
    }
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const keys = Object.keys(value)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!
    const at = keyPath(path, key, i)
    if (UNSAFE_TEST.test(key)) return `${at} key`
    const found = find((value as Record<string, unknown>)[key], at)
    if (found !== null) return found
  }
  return null
}

/**
 * The path of the first string or object key PostgreSQL cannot hold, or null
 * when there is none. An unsafe key's path ends in ` key`; the root is ''.
 */
export function findPostgresUnsafeText(value: unknown): string | null {
  return find(value, '')
}
