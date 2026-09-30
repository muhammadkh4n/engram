/**
 * Passwords in URL userinfo (`scheme://user:password@host`), delimited by URL
 * syntax alone, so a password made of any characters is found whole.
 *
 * The authority runs from `//` to whitespace (or to the quote that wraps the
 * URL). Its userinfo ends at the last `@` before the first `/`, `?` or `#`
 * that follows an `@`: a password may itself hold `/`, `#` or `@`, while a
 * path or query after the host may hold `@` too (`?email=a@b.c`). The user
 * part cannot contain `/`, `?` or `#`, and `host:8080/@scope` is a port and a
 * path, not a password.
 */

import { PLACEHOLDER_PREFIX } from './placeholder.js'
import { isShellReference } from './value-extent.js'

export interface UrlPassword {
  start: number
  end: number
  kind: string
  isPlaceholder: boolean
}

// Documentation placeholders: `...`, `<pwd>`, `xxxx`, `****`. `<` and `>`
// cannot appear unencoded in a URL, so `<pwd>` is never a password.
export const DOC_PLACEHOLDER_RE = /(?:\.\.\.|…)$|^<[^>]*>$|^(?:x{3,}|\*{3,})$/i

// Authorities are length-bounded to keep the scan linear.
const URL_AUTHORITY_RE = /\b([a-z][a-z0-9+.-]{0,31}):\/\/(\S{1,2048})/gi
const PATH_START_RE = /[/?#]/
const PORT_THEN_PATH_RE = /^\d+[/?#]/

function urlKind(scheme: string): string {
  const s = scheme.toLowerCase()
  if (s === 'postgres' || s === 'postgresql') return 'postgres-url'
  if (s === 'http' || s === 'https') return 'http-url'
  return 'url-password'
}

/** A URL wrapped in quotes (`'postgres://u:p@h'`) ends at the matching quote. */
function authorityWithinQuotes(text: string, schemeStart: number, authority: string): string {
  const quote = text.charAt(schemeStart - 1)
  if (quote !== '"' && quote !== "'" && quote !== '`') return authority
  const close = authority.indexOf(quote)
  return close === -1 ? authority : authority.slice(0, close)
}

function userinfoEnd(authority: string): number {
  const firstAt = authority.indexOf('@')
  if (firstAt === -1) return -1
  const rest = authority.slice(firstAt)
  const pathAt = rest.search(PATH_START_RE)
  const limit = pathAt === -1 ? authority.length : firstAt + pathAt
  return authority.lastIndexOf('@', limit - 1)
}

export function urlPasswords(text: string, from: number, to: number): UrlPassword[] {
  const found: UrlPassword[] = []
  for (const m of text.slice(from, to).matchAll(URL_AUTHORITY_RE)) {
    const schemeStart = from + (m.index ?? 0)
    const authorityStart = schemeStart + (m[1] ?? '').length + 3
    const authority = authorityWithinQuotes(text, schemeStart, m[2] ?? '')
    const at = userinfoEnd(authority)
    if (at === -1) continue
    const colon = authority.indexOf(':')
    if (colon === -1 || colon > at || PATH_START_RE.test(authority.slice(0, colon))) continue
    const password = authority.slice(colon + 1, at)
    if (password === '' || PORT_THEN_PATH_RE.test(password)) continue
    const isPlaceholder =
      password.startsWith(PLACEHOLDER_PREFIX) || DOC_PLACEHOLDER_RE.test(password) || isShellReference(password)
    found.push({ start: authorityStart + colon + 1, end: authorityStart + at, kind: urlKind(m[1] ?? ''), isPlaceholder })
  }
  return found
}
