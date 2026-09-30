/**
 * Publicly known passwords (common-password and vendor-default lists). A
 * value on these lists is not a secret, however it is stored: `.env.example`
 * and local dev `.env` files carry `postgres`/`changeme`-style defaults, and
 * masking those everywhere erases ordinary words ("postgres 16") from memory.
 *
 * The list ships as `data/common-passwords.txt` next to this module. Builds
 * that bundle this source (the OpenClaw plugin) copy it to `data/` next to
 * the bundle, where the same relative URL finds it.
 */

import { readFileSync } from 'node:fs'

const LIST_URL = new URL('./data/common-passwords.txt', import.meta.url)

/**
 * Parses the bundled list: every line up to the first empty line is the
 * license header, every non-empty line after it is one value (values may
 * start with `#`). Values are lower-cased for case-insensitive lookup.
 */
export function parseCommonPasswords(content: string): Set<string> {
  const lines = content.split(/\r?\n/)
  const headerEnd = lines.indexOf('')
  const values = new Set<string>()
  for (const line of lines.slice(headerEnd + 1)) {
    if (line !== '') values.add(line.toLowerCase())
  }
  return values
}

let cached: Set<string> | undefined

/**
 * The bundled list, read once. When the file is missing (a build that did not
 * copy it) the set is empty and the reason is logged once: defaults are then
 * masked like any other registered value, which over-masks but never leaks.
 */
export function commonPasswords(log: (line: string) => void): ReadonlySet<string> {
  if (cached !== undefined) return cached
  try {
    cached = parseCommonPasswords(readFileSync(LIST_URL, 'utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    log(`common-password list unreadable (${typeof code === 'string' ? code : 'error'}); public defaults are not exempt`)
    cached = new Set()
  }
  return cached
}

export function isCommonPassword(value: string, list: ReadonlySet<string>): boolean {
  return list.has(value.toLowerCase())
}
