/**
 * Reads the secret values out of one configured source file. Every format is
 * structured data, so a key's name reliably says what its value holds and
 * decides whether the value is a secret. Parse failures are reported by a
 * fixed reason only: parser messages quote the input, and the input is
 * secret.
 */

import { basename } from 'node:path'
import { parseAllDocuments } from 'yaml'
import { isPublicKey, isPublishableValue, isStructuredSecretKey, keyWords } from './secret-keys.js'

export const SOURCE_FORMATS = ['value', 'dotenv', 'ini', 'json-keys', 'yaml-keys', 'npmrc', 'git-credentials'] as const
export type SourceFormat = (typeof SOURCE_FORMATS)[number]

export interface NamedValue {
  name: string
  value: string
}

/** `unnamed`: a file whose name does not name a credential (a URL, a username, an email address). */
export type SourceParse = { values: NamedValue[] } | { skipped: string } | { unnamed: true }

const MAX_DEPTH = 64

const PEM_BLOCK_RE = /^-----BEGIN [A-Z0-9 ]+-----\r?\n[\s\S]*\r?\n-----END [A-Z0-9 ]+-----$/

/**
 * sops-nix renders one secret per file, named after the key, and the same
 * store also holds plain configuration (`JIRA_URL`, `*_EMAIL`), so the file
 * name is judged as the key.
 */
function parseValueFile(content: string, file: string): SourceParse {
  const name = basename(file)
  if (!isStructuredSecretKey(name) || isPublicKey(name)) return { unnamed: true }
  const value = content.trim()
  if (value === '') return { skipped: 'empty' }
  if (/\s/.test(value) && !PEM_BLOCK_RE.test(value)) return { skipped: 'not a single token or PEM block' }
  return { values: [{ name, value }] }
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000e-\u001f�]/

/** The text a base64 value encodes, when it is canonical base64 of printable UTF-8. */
function decodeBase64Text(encoded: string): string | undefined {
  if (!BASE64_RE.test(encoded)) return undefined
  const text = Buffer.from(encoded, 'base64').toString('utf8')
  const canonical = Buffer.from(text, 'utf8').toString('base64')
  if (canonical.replace(/=+$/, '') !== encoded.replace(/=+$/, '') || CONTROL_CHARS_RE.test(text)) return undefined
  return text
}

/** The password of a `user:password` pair, as in a Basic credential or npm's `_auth`. */
function passwordOfPair(pair: string | undefined): string[] {
  const colon = pair?.indexOf(':') ?? -1
  return pair !== undefined && colon !== -1 ? [pair.slice(colon + 1)] : []
}

const URL_AUTHORITY_RE = /^[a-z][a-z0-9+.-]*:\/\/([^\s/?#]+)/i

interface UrlCredential {
  host: string
  passwords: string[]
}

/** The password in a URL's userinfo, as written and percent-decoded. */
function urlCredential(value: string): UrlCredential | undefined {
  const authority = URL_AUTHORITY_RE.exec(value.trim())?.[1]
  if (authority === undefined) return undefined
  const at = authority.lastIndexOf('@')
  const colon = authority.indexOf(':')
  if (at === -1 || colon === -1 || colon > at) return undefined
  const raw = authority.slice(colon + 1, at)
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // A malformed escape: the raw spelling is still registered.
  }
  return { host: authority.slice(at + 1), passwords: [raw, decoded] }
}

const AUTH_SCHEMES = new Set(['bearer', 'basic', 'token'])
const SCHEME_VALUE_RE = /^([A-Za-z][\w.~+-]*)[ \t]+(\S+)$/
const AUTHORIZATION_LINE_RE = /^(?:proxy-)?authorization[ \t]*:[ \t]*([A-Za-z][\w.~+-]*)[ \t]+(\S+)$/i

/** The credential of `<scheme> <credential>`; for Basic, also the password it encodes. */
function schemeCredential(scheme: string, credential: string): string[] {
  const decoded = scheme.toLowerCase() === 'basic' ? passwordOfPair(decodeBase64Text(credential)) : []
  return [credential, ...decoded]
}

function isAuthorizationKey(name: string): boolean {
  return keyWords(name).at(-1) === 'authorization'
}

/** Values to register for one key/value pair of structured data. */
function pairValues(name: string, rawValue: string): NamedValue[] {
  const value = rawValue.trim()
  const found = [...(urlCredential(value)?.passwords ?? [])]
  const headerLine = AUTHORIZATION_LINE_RE.exec(value)
  if (headerLine) found.push(...schemeCredential(headerLine[1]!, headerLine[2]!))
  if (isStructuredSecretKey(name) && !isPublicKey(name) && !isPublishableValue(value)) {
    const scheme = SCHEME_VALUE_RE.exec(value)
    const isScheme = scheme !== null && (isAuthorizationKey(name) || AUTH_SCHEMES.has(scheme[1]!.toLowerCase()))
    if (isScheme) found.push(...schemeCredential(scheme[1]!, scheme[2]!))
    else found.push(value)
  }
  return found.map((v) => ({ name, value: v }))
}

const DOTENV_LINE_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]*)[ \t]*=[ \t]*(.*)$/

function closingQuote(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === '\\') i++
    else if (body[i] === quote) return i
  }
  return -1
}

const DOUBLE_QUOTED_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t' }

function unescapeDoubleQuoted(raw: string): string {
  return raw.replace(/\\([\\"nrt$`])/g, (_, c: string) => DOUBLE_QUOTED_ESCAPES[c] ?? c)
}

/** `KEY=value` lines, with `export`, quotes and multi-line quoted values; both spellings of an escaped value. */
function dotenvPairs(content: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = DOTENV_LINE_RE.exec(lines[i]!)
    if (!m) continue
    const [, key, rest] = m as unknown as [string, string, string]
    const quote = rest.charAt(0)
    if (quote !== '"' && quote !== "'" && quote !== '`') {
      pairs.push([key, rest.replace(/[ \t]+#.*$/, '')])
      continue
    }
    let body = rest.slice(1)
    let end = i
    let close = closingQuote(body, quote)
    while (close === -1 && end + 1 < lines.length) {
      body += `\n${lines[++end]}`
      close = closingQuote(body, quote)
    }
    if (close === -1) {
      pairs.push([key, rest.slice(1)])
      continue
    }
    const raw = body.slice(0, close)
    pairs.push([key, raw])
    if (quote === '"') pairs.push([key, unescapeDoubleQuoted(raw)])
    i = end
  }
  return pairs
}

function unquote(value: string): string {
  const q = value.charAt(0)
  return value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q) ? value.slice(1, -1) : value
}

const INI_LINE_RE = /^[ \t]*([^=:;#[\s][^=:]*?)[ \t]*[=:][ \t]*(.*?)[ \t]*$/

/** `key = value` (or `key: value`) lines; sections and `;`/`#` comments skipped. */
function iniPairs(content: string): Array<[string, string]> {
  return content.split(/\r?\n/).flatMap((line): Array<[string, string]> => {
    const m = INI_LINE_RE.exec(line)
    if (!m) return []
    const [, key, value] = m as unknown as [string, string, string]
    const withoutComment = value.replace(/[ \t]+[;#].*$/, '')
    return [[key, unquote(value)], [key, unquote(withoutComment)]]
  })
}

const NPMRC_LINE_RE = /^[ \t]*([^=;#\s][^=]*?)[ \t]*=[ \t]*(.*?)[ \t]*$/
const NPM_CREDENTIAL_RE = /(?:^|:)(_authToken|_auth|_password)$/

/** `_authToken`, `_auth` (base64 `user:password`) and `_password` (base64), with or without a registry prefix. */
function npmrcValues(content: string): NamedValue[] {
  return content.split(/\r?\n/).flatMap((line) => {
    const m = NPMRC_LINE_RE.exec(line)
    const name = m ? NPM_CREDENTIAL_RE.exec(m[1]!)?.[1] : undefined
    if (!m || name === undefined) return []
    const value = unquote(m[2]!)
    const decoded = decodeBase64Text(value)
    const plain = name === '_auth' ? passwordOfPair(decoded) : name === '_password' && decoded !== undefined ? [decoded] : []
    return [value, ...plain].map((v) => ({ name, value: v }))
  })
}

/** One `scheme://user:password@host` URL per line. */
function gitCredentialValues(content: string): NamedValue[] {
  return content.split(/\r?\n/).flatMap((line) => {
    const credential = urlCredential(line)
    if (!credential) return []
    return credential.passwords.map((value) => ({ name: `git-credentials:${credential.host}`, value }))
  })
}

/** Every string leaf with the key it sits under; array items inherit their array's key. */
function stringLeaves(node: unknown, key: string | undefined, out: Array<[string, string]>, depth = 0): void {
  if (depth > MAX_DEPTH) return
  if (typeof node === 'string') {
    if (key !== undefined) out.push([key, node])
  } else if (Array.isArray(node)) {
    for (const item of node) stringLeaves(item, key, out, depth + 1)
  } else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) stringLeaves(v, k, out, depth + 1)
  }
}

function jsonPairs(content: string): Array<[string, string]> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  const pairs: Array<[string, string]> = []
  stringLeaves(parsed, undefined, pairs)
  return pairs
}

/** The failsafe schema keeps every scalar a string, so `password: 123456` is read as written. */
function yamlPairs(content: string): Array<[string, string]> | undefined {
  const pairs: Array<[string, string]> = []
  try {
    for (const doc of parseAllDocuments(content, { schema: 'failsafe', uniqueKeys: false })) {
      if (doc.errors.length > 0) return undefined
      stringLeaves(doc.toJS({ maxAliasCount: 100 }), undefined, pairs)
    }
  } catch {
    return undefined
  }
  return pairs
}

function fromPairs(pairs: Array<[string, string]> | undefined, format: string): SourceParse {
  if (pairs === undefined) return { skipped: `not valid ${format}` }
  return { values: pairs.flatMap(([key, value]) => pairValues(key, value)) }
}

export function parseSource(format: SourceFormat, content: string, file: string): SourceParse {
  switch (format) {
    case 'value':
      return parseValueFile(content, file)
    case 'dotenv':
      return fromPairs(dotenvPairs(content), 'dotenv')
    case 'ini':
      return fromPairs(iniPairs(content), 'ini')
    case 'json-keys':
      return fromPairs(jsonPairs(content), 'JSON')
    case 'yaml-keys':
      return fromPairs(yamlPairs(content), 'YAML')
    case 'npmrc':
      return { values: npmrcValues(content) }
    case 'git-credentials':
      return { values: gitCredentialValues(content) }
  }
}
