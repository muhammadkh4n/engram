/**
 * Redacts credential values from free text before it is stored, embedded or
 * sent to a summarisation model. Key names are kept so the memory still says
 * *which* secret was involved; only the value is replaced.
 *
 * Passes run in a fixed order:
 *   1. PEM private-key blocks (multi-line, so they go before any line-based rule)
 *   2. passwords inside connection-string / URL userinfo
 *   3. values assigned to secret-named keys (`NAME=value`, `NAME: value`, JSON)
 *   4. known credential formats anywhere in text (provider key prefixes, JWTs)
 *   5. high-entropy values after `=` / `:` whose key name gave no signal
 *
 * Every placeholder has the form `[REDACTED:<label>]` and no pass matches a
 * placeholder, so scrubbing already-scrubbed text is a no-op.
 */

export interface SecretRedaction {
  kind: string
  name?: string
}

export interface ScrubResult {
  text: string
  redactions: SecretRedaction[]
}

const PLACEHOLDER_PREFIX = '[REDACTED:'
const PLACEHOLDER_RE = /\[REDACTED:[^\]\n]*\]/g

function placeholder(label: string): string {
  return `${PLACEHOLDER_PREFIX}${label}]`
}

// AUTH matches AUTHORIZATION but not AUTHOR, so `Author:` lines in git output
// are left alone. TOKENS / TOKENIZER name LLM token counts and settings
// (`max_tokens`, `approx_tokens`), never a credential.
const SECRET_WORD = String.raw`(?:SECRET|TOKEN(?!S|IZ)|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH(?!OR(?!IZ)))`
// Key names, values and URL schemes are length-bounded so that a long
// identifier-like run (base64, minified code) costs linear time, not quadratic.
const SECRET_KEY = String.raw`(?=[A-Za-z_])[\w.-]{0,64}?${SECRET_WORD}[\w.-]{0,64}`
const VALUE_CHARS = String.raw`[^\s'"\`,;(){}\[\]<>&]`
const VALUE_END = String.raw`(?=$|[\s'"\`,;)}\]&])`
const AUTH_SCHEME = String.raw`(?:Bearer|Basic|Token|Digest)[ \t]+`

// The optional spaces after the separator refuse to run into another `KEY=`
// (the regex is case-insensitive), so `OPENAI_API_KEY= NEO4J_PASSWORD=x` keeps
// both names and attributes the value to the key it belongs to.
const ASSIGNMENT_RE = new RegExp(
  String.raw`(?<![\w.$])(["']?)(${SECRET_KEY})\1` +
    String.raw`([ \t]*[=:](?:[ \t]+(?![A-Z][A-Z0-9_]*=))?)(?![=:])` +
    String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|\`([^\`\n]*)\`|(${AUTH_SCHEME})?(?!${AUTH_SCHEME})(${VALUE_CHARS}{1,1024})${VALUE_END})`,
  'gim',
)

const LITERAL_VALUES = new Set([
  'true', 'false', 'null', 'nil', 'none', 'undefined', 'yes', 'no', 'on', 'off',
  'string', 'number', 'boolean', 'unknown', 'any', 'never', 'object', 'void', 'bigint', 'symbol',
])

function isOnlyPlaceholders(value: string): boolean {
  return value.includes(PLACEHOLDER_PREFIX) && value.replace(PLACEHOLDER_RE, '').replace(/\\n|\s/g, '') === ''
}

// Counts and amounts: `4096`, `~99K`, `$0.05`, `30%`. Exempt only under a
// qualified name (`TOKEN_LIMIT`, `AUTH_TIMEOUT_MS`); `DB_PASSWORD=12345678` is a PIN.
const NAME_ENDS_IN_SECRET_WORD_RE = new RegExp(`${SECRET_WORD}$`, 'i')
const QUANTITY_RE = /^[~<>]?[$€£]?-?\d[\d,.]*[KkMmGg%]?$/
// Documentation placeholders: `...`, `sk-...`, `<pwd>`, `xxxx`, `****`.
const DOC_PLACEHOLDER_RE = /(?:\.\.\.|…)$|^<[^>]*>$|^(?:x{3,}|\*{3,})$/i
// `$VAR`, `${VAR}`, `$(cmd)`, `%VAR%`: resolved elsewhere, not a literal secret.
const INDIRECTION_RE = /^\$[{(]?[A-Za-z_]|^%[A-Za-z_]+%$/
// `process.env.X!`, `opts.token`, `resp.usage?.prompt_tokens`: a code reference.
const MEMBER_PATH_RE = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+!?$/
// `ANSWER_MAX_TOKENS`: the name of a constant.
const CONSTANT_NAME_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
// `openaiKey`: a camelCase variable passed by name in code.
const CAMEL_IDENTIFIER_RE = /^[a-z]+(?:[A-Z][a-z]+)+$/
// Keys that say where a secret is found rather than holding it:
// `DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'`, `TOKEN_FILE=/run/secrets/token`, `passwordPath`.
const VARIABLE_KEY_RES = [/[_.-](?:ENV|NAME|VAR|FILE|PATH)$/i, /[a-z0-9](?:Env|Name|Var|File|Path)$/]

function isVariableKey(name: string): boolean {
  return VARIABLE_KEY_RES.some((re) => re.test(name))
}

/** Values that cannot be a credential whatever syntax surrounds them. */
function isInertValue(value: string, name: string): boolean {
  if (value === '' || isOnlyPlaceholders(value)) return true
  if (QUANTITY_RE.test(value)) return !NAME_ENDS_IN_SECRET_WORD_RE.test(name)
  return LITERAL_VALUES.has(value.toLowerCase()) || DOC_PLACEHOLDER_RE.test(value)
}

/**
 * A quoted value is a literal in every language, so its shape proves nothing: a
 * password can look like a constant or a camelCase word. Only shell expansion
 * inside double quotes and template interpolation make it a reference.
 */
function isQuotedReference(value: string, quote: string): boolean {
  if (quote === '"') return INDIRECTION_RE.test(value)
  return quote === '`' && value.includes('${')
}

/** Identifier shapes, exempt only where the syntax shows the value is a code expression. */
function isCodeReference(value: string): boolean {
  return [MEMBER_PATH_RE, CONSTANT_NAME_RE, CAMEL_IDENTIFIER_RE].some((re) => re.test(value))
}

function isEnvStyleKey(name: string): boolean {
  return /[_.-]/.test(name) || name === name.toUpperCase()
}

function isAtLineStart(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*(?:-[ \t]+)?$/.test(text.slice(lineStart, offset))
}

function restOfLine(text: string, offset: number): string {
  const lineEnd = text.indexOf('\n', offset)
  return text.slice(offset, lineEnd === -1 ? text.length : lineEnd)
}

/**
 * Whether an unquoted value sits in data syntax (its text is the value) or in
 * code syntax (it may name a variable). Data: a tight `NAME=value` (env line,
 * `export`, CLI flag, query string), an auth-scheme header, a `key: value`
 * inside a string, or a line-leading `key: value` with nothing code-like after
 * it (YAML, env dumps, HTTP headers). Everything else is code: a mid-line
 * assignment or a line-leading pair followed by `,` `;` `(` or `{`.
 */
function isDataSyntax(text: string, offset: number, keyQuote: string, sep: string, valueEnd: number): boolean {
  if (sep === '=') return true
  if (!keyQuote && /["']/.test(text.charAt(offset - 1))) return true
  if (!isAtLineStart(text, offset)) return false
  return !/^\s*[,;({]|[,;({]\s*$/.test(restOfLine(text, valueEnd))
}

/**
 * A plain word after a code-style key (`password: see the runbook`,
 * `const token = await …`) is prose or code, not a credential.
 */
function isProseOrCode(name: string, separator: string, value: string, lineLeading: boolean): boolean {
  if (!/^[A-Za-z]+$/.test(value) || isEnvStyleKey(name) || lineLeading) return false
  const trimmed = separator.trim()
  return trimmed === ':' || separator !== trimmed
}

interface BarePair {
  offset: number
  end: number
  keyQuote: string
  name: string
  sep: string
  hasScheme: boolean
  value: string
}

function isExemptBareValue(text: string, pair: BarePair): boolean {
  const { offset, end, keyQuote, name, sep, hasScheme, value } = pair
  if (INDIRECTION_RE.test(value)) return true
  if (hasScheme || isDataSyntax(text, offset, keyQuote, sep, end)) return false
  return isCodeReference(value) || isProseOrCode(name, sep, value, isAtLineStart(text, offset))
}

function redactAssignments(text: string, redactions: SecretRedaction[]): string {
  return text.replace(
    ASSIGNMENT_RE,
    (
      match: string,
      keyQuote: string,
      name: string,
      sep: string,
      dq: string | undefined,
      sq: string | undefined,
      bt: string | undefined,
      scheme: string | undefined,
      bare: string | undefined,
      offset: number,
    ) => {
      if (isVariableKey(name)) return match
      const quotedValue = dq ?? sq ?? bt
      if (quotedValue !== undefined) {
        const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '`'
        if (isInertValue(quotedValue, name) || isQuotedReference(quotedValue, q)) return match
        redactions.push({ kind: 'named-secret', name })
        return `${keyQuote}${name}${keyQuote}${sep}${q}${placeholder(name)}${q}`
      }
      const value = bare ?? ''
      if (isInertValue(value, name)) return match
      const pair = { offset, end: offset + match.length, keyQuote, name, sep, hasScheme: scheme !== undefined, value }
      if (isExemptBareValue(text, pair)) return match
      redactions.push({ kind: 'named-secret', name })
      return `${keyQuote}${name}${keyQuote}${sep}${scheme ?? ''}${placeholder(name)}`
    },
  )
}

const PEM_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$(?![\s\S]))/g

function redactPem(text: string, redactions: SecretRedaction[]): string {
  return text.replace(PEM_RE, () => {
    redactions.push({ kind: 'private-key' })
    return placeholder('private-key')
  })
}

const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]{0,31}):\/\/([^\s:@\/'"]*):([^\s@\/'"]+)@/gi

function urlKind(scheme: string): string {
  const s = scheme.toLowerCase()
  if (s === 'postgres' || s === 'postgresql') return 'postgres-url'
  if (s === 'http' || s === 'https') return 'http-url'
  return 'url-password'
}

function redactUrlPasswords(text: string, redactions: SecretRedaction[]): string {
  return text.replace(URL_USERINFO_RE, (match, scheme: string, user: string, password: string) => {
    if (password.startsWith(PLACEHOLDER_PREFIX) || DOC_PLACEHOLDER_RE.test(password)) return match
    const kind = urlKind(scheme)
    redactions.push({ kind })
    return `${scheme}://${user}:${placeholder(kind)}@`
  })
}

// Order matters: the provider-specific `sk-` prefixes run before the generic one.
const KNOWN_FORMATS: ReadonlyArray<readonly [string, RegExp]> = [
  ['anthropic-key', /(?<![\w-])sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openrouter-key', /(?<![\w-])sk-or-v1-[A-Za-z0-9]{20,}/g],
  ['openai-key', /(?<![\w-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /(?<![\w-])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['aws-access-key', /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g],
  ['slack-token', /(?<![\w-])xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['jwt', /(?<![\w-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g],
]

function redactKnownFormats(text: string, redactions: SecretRedaction[]): string {
  let out = text
  for (const [kind, re] of KNOWN_FORMATS) {
    out = out.replace(re, () => {
      redactions.push({ kind })
      return placeholder(kind)
    })
  }
  return out
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

function redactHighEntropy(text: string, redactions: SecretRedaction[]): string {
  return text.replace(HIGH_ENTROPY_RE, (token: string) => {
    if (!looksRandom(token)) return token
    redactions.push({ kind: 'high-entropy' })
    return placeholder('high-entropy')
  })
}

export function scrubSecrets(text: string): ScrubResult {
  const redactions: SecretRedaction[] = []
  let out = redactPem(text, redactions)
  out = redactUrlPasswords(out, redactions)
  out = redactAssignments(out, redactions)
  out = redactKnownFormats(out, redactions)
  out = redactHighEntropy(out, redactions)
  return { text: out, redactions }
}
