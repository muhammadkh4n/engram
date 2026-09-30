/**
 * Decides from a key's name alone whether the value assigned to it is a
 * credential. The key is split into words (snake, kebab, camel, dot) and its
 * last word decides: `NEO4J_PASSWORD`, `authToken` and `X-Api-Key` hold
 * secrets; `TOKEN_LIMIT`, `MAX_TOKENS`, `AUTH_ENABLED`, `ACCESS_KEY_ID` and
 * `DEFAULT_API_KEY_ENV` name a setting or another variable.
 */

const CREDENTIAL_WORDS = new Set([
  'password', 'passwd', 'pwd', 'pw', 'pass', 'passphrase', 'secret', 'token',
  'credential', 'credentials', 'auth', 'authorization', 'dsn', 'salt', 'cookie',
])

// `PGPASSWORD`, `clientsecret`, `apitoken`: a credential noun fused into one word.
const CREDENTIAL_SUFFIXES = ['password', 'passwd', 'secret', 'token', 'pwd']

// `APIKEY`, `SECRETKEY`: `<qualifier>_KEY` written as one word.
const FUSED_KEY_WORDS = new Set([
  'apikey', 'secretkey', 'privatekey', 'accesskey', 'authkey', 'masterkey', 'signingkey', 'encryptionkey', 'licensekey',
])

// `<word>_KEY` where the key names or indexes data rather than unlocking
// anything. In structured data (config and env files) only these qualify:
// there a key reliably says what its value holds, so `PROJECT_KEY` or
// `UPLOAD_KEY` in a secrets file is treated as a credential.
const DATA_STRUCTURE_WORDS = new Set([
  'cache', 'sort', 'primary', 'foreign', 'partition', 'idempotency', 'routing', 'shard', 'lookup',
  'object', 'bucket', 'map', 'row', 'cursor', 'hash', 'translation',
])

// In free text many more words before `KEY` name data than a credential:
// `issue_key` holds a ticket id, `COLUMN_KEY` MySQL's PRI/MUL, `stepKey` a
// workflow step.
const FREE_TEXT_DATA_STRUCTURE_WORDS = new Set([
  ...DATA_STRUCTURE_WORDS,
  'sorting', 'column', 'query', 'storage', 'state',
  'context', 'index', 'range', 'group', 'dedup', 'dedupe', 'unique', 'composite', 'issue', 'project', 'step',
  'payload', 'scope', 'target', 'source', 'catalog', 'filter', 'version', 'holder', 'item', 'entry', 'field',
  'record', 'table', 'node', 'event', 'message', 'type', 'category', 'parent', 'child', 'page', 'label',
  'locale', 'option', 'component', 'element', 'prop', 'data', 'meta', 'metadata', 'schema', 'list', 'tree',
  'x', 'y', 'angle', 'color', 'size', 'radius', 'sector', 'callout', 'legend', 'series', 'icon', 's3', 'upload',
  'view', 'views', 'date', 'marker', 'coverage', 'topology', 'allocation', 'uniqueness', 'idem', 'req',
  'request', 'response', 'route', 'path', 'file', 'folder', 'image', 'asset', 'cell', 'tab', 'menu', 'link',
])

// `no-auth`, `non-secret`, `withoutToken`: the key says there is no credential.
const NEGATION_WORDS = new Set(['no', 'non', 'not', 'without'])

// Standard headers whose last word names a credential but whose value never is one.
const NON_SECRET_KEYS = new Set(['access-control-allow-credentials'])

// Trailing words that pick a variant of the same credential:
// `DB_PASSWORD_PROD`, `STRIPE_SECRET_KEY_LIVE`, `API_KEY_V2`, `PRIVATE_KEY_B64`.
const QUALIFIER_WORDS = new Set([
  'prod', 'production', 'dev', 'development', 'staging', 'stage', 'stg', 'test', 'testing', 'qa', 'uat',
  'preprod', 'local', 'live', 'sandbox', 'demo', 'old', 'new', 'prev', 'previous', 'next', 'current',
  'backup', 'alt', 'fallback', 'legacy', 'for', 'b64', 'base64', 'hex', 'json', 'encoded', 'raw', 'pem',
])
const VERSION_WORD_RE = /^v?\d+$/

// Rails' `SECRET_KEY_BASE` ends in a word that names nothing secret on its own.
const SECRET_WORD_SEQUENCES: ReadonlyArray<readonly string[]> = [['secret', 'key', 'base']]

// POSIX working-directory variables, printed by every `env` dump.
const WORKDIR_KEYS = new Set(['PWD', 'OLDPWD'])

// Credential words that, as the whole key, are more often something else:
// `pass` alone is a noun in prose ("that pass:") and a test status (`PASS:`);
// `DB_PASS` and `smtpPass` still qualify.
const QUALIFIED_ONLY_WORDS = new Set(['pass'])

// Values meant to ship to browsers or apps: Supabase anon keys, publishable keys,
// public keys, Sentry's DSN key (sent by every browser event), and every
// variable a frontend bundler inlines into client code.
const PUBLIC_WORDS = new Set(['public', 'publishable', 'anon'])
const PUBLIC_WORD_SEQUENCES: ReadonlyArray<readonly string[]> = [['sentry', 'key']]
const BROWSER_EXPOSED_PREFIXES = ['NEXT_PUBLIC_', 'VITE_', 'REACT_APP_', 'EXPO_PUBLIC_', 'GATSBY_', 'NUXT_PUBLIC_']
const PUBLISHABLE_VALUE_RE = /^pk_(?:live|test)_/

export function keyWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.\-]+/)
    .filter((w) => w !== '')
    .map((w) => w.toLowerCase())
}

function withoutQualifiers(words: string[]): string[] {
  let end = words.length
  while (end > 1 && (QUALIFIER_WORDS.has(words[end - 1]!) || VERSION_WORD_RE.test(words[end - 1]!))) end--
  return words.slice(0, end)
}

function endsWithSequence(words: string[], sequence: readonly string[]): boolean {
  if (words.length < sequence.length) return false
  const tail = words.slice(words.length - sequence.length)
  return sequence.every((w, i) => tail[i] === w)
}

function isCredentialWord(word: string): boolean {
  return CREDENTIAL_WORDS.has(word) || FUSED_KEY_WORDS.has(word) || CREDENTIAL_SUFFIXES.some((s) => word.endsWith(s))
}

interface KeyRule {
  dataStructureWords: ReadonlySet<string>
  /** Prose uses `no-auth`, `non-secret` and a bare `pass` without meaning a credential. */
  proseGuards: boolean
}

const FREE_TEXT_RULE: KeyRule = { dataStructureWords: FREE_TEXT_DATA_STRUCTURE_WORDS, proseGuards: true }
const STRUCTURED_RULE: KeyRule = { dataStructureWords: DATA_STRUCTURE_WORDS, proseGuards: false }

function judgeKey(name: string, rule: KeyRule): boolean {
  if (WORKDIR_KEYS.has(name) || NON_SECRET_KEYS.has(name.toLowerCase())) return false
  const words = withoutQualifiers(keyWords(name))
  if (rule.proseGuards && words.length > 1 && NEGATION_WORDS.has(words[words.length - 2]!)) return false
  if (SECRET_WORD_SEQUENCES.some((seq) => endsWithSequence(words, seq))) return true
  const last = words[words.length - 1]
  if (last === undefined) return false
  if (rule.proseGuards && words.length === 1 && QUALIFIED_ONLY_WORDS.has(last)) return false
  if (isCredentialWord(last)) return true
  if (last !== 'key') return false
  const before = words[words.length - 2]
  return before !== undefined && !rule.dataStructureWords.has(before)
}

/** Whether a value assigned to this key in free text is a credential, judged by the key's last word. */
export function isSecretKey(name: string): boolean {
  return judgeKey(name, FREE_TEXT_RULE)
}

/**
 * The same last-word rule for keys in structured data (env, ini, JSON and
 * YAML files), where a key names its value reliably: a bare `pass` is a
 * credential, and only the core data-structure words exempt `<word>_KEY`.
 */
export function isStructuredSecretKey(name: string): boolean {
  return judgeKey(name, STRUCTURED_RULE)
}

/** Keys whose values are public by design, whatever their last word says. */
export function isPublicKey(name: string): boolean {
  const upper = name.toUpperCase()
  if (BROWSER_EXPOSED_PREFIXES.some((p) => upper.startsWith(p))) return true
  const words = keyWords(name)
  return words.some((w) => PUBLIC_WORDS.has(w)) || PUBLIC_WORD_SEQUENCES.some((seq) => endsWithSequence(words, seq))
}

export function isPublishableValue(value: string): boolean {
  return PUBLISHABLE_VALUE_RE.test(value)
}
