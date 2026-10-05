/**
 * Masks known secret values: the ones sitting in files this machine already
 * keeps secrets in (sops-rendered secrets, `.env` files, `.npmrc`,
 * `.git-credentials`). A value that is known needs no guess about its shape
 * or the syntax around it, so it is found in prose, code, JSON, URLs and
 * base64 alike (see encoded-forms.ts).
 *
 * `ENGRAM_SECRET_SOURCES_FILE` names a JSON file:
 *   { "sources": [{ "path": "~/.config/app/*.env", "format": "dotenv", "exclude": ["**\/test/**"] }] }
 * `path` may be a glob; formats are listed in secret-source-formats.ts.
 * An unset or unreadable configuration leaves the registry empty and says so
 * once on stderr; nothing here throws.
 *
 * Publicly known passwords (common-password and vendor-default lists, see
 * common-passwords.ts) are never registered: they are not secret, and
 * masking a dev default such as `postgres` would erase an ordinary word.
 *
 * A caller may also pass values it already holds (`values`), such as the
 * process's own credentials; they are registered alongside the sources and
 * whatever the configuration's state.
 *
 * Values stay in this process's memory: they are never logged, and no
 * message or error built here carries one. Sources are read on first use and
 * read again when any source file, a directory a glob walked, or the
 * configuration itself changes, checked at most once per minute.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { commonPasswords, isCommonPassword } from './common-passwords.js'
import { encodedForms } from './encoded-forms.js'
import { isOnlyPlaceholders, placeholderRanges } from './placeholder.js'
import { expandHome, openGlobPathCache } from './source-glob.js'
import { SOURCE_FORMATS, parseSource } from './secret-source-formats.js'
import type { NamedValue, SourceFormat } from './secret-source-formats.js'
import { isShellReference } from './value-extent.js'

export const SECRET_SOURCES_ENV = 'ENGRAM_SECRET_SOURCES_FILE'

/** Shorter values (and shorter encoded spellings) match ordinary words too often. */
export const MIN_SECRET_LENGTH = 6
const RECHECK_INTERVAL_MS = 60_000

export interface KnownValueSpan {
  start: number
  end: number
  /** The key or file the value was registered under. */
  name: string
}

/**
 * What the last build of the registry saw, never a value. A caller that must
 * not run on a partial registry (masking stored text, counting stored
 * secrets) checks it first: an empty or partly read registry masks less and
 * would report a false zero.
 */
export interface SecretRegistryStatus {
  /** The sources configuration was set, read and parsed. */
  configured: boolean
  /** Paths of the configuration or source files whose read failed. */
  unreadable: string[]
  /** How many distinct values are registered. */
  values: number
}

export interface SecretRegistry {
  /** Every occurrence of a registered value, in any of its spellings, longest spelling first at each offset. */
  findKnownValues(text: string): KnownValueSpan[]
  status(): SecretRegistryStatus
}

export interface SecretRegistryOptions {
  /** Path of the sources configuration; `undefined` means none is configured. */
  configPath: string | undefined
  /** File caching glob walk results (paths and directory mtimes only); `undefined` walks every build. */
  pathCacheFile?: string
  /** Values registered alongside the sources' values, under their own names. */
  values?: readonly NamedValue[]
  now?: () => number
  log?: (line: string) => void
}

interface SourceEntry {
  path: string
  format: SourceFormat
  exclude: string[]
}

interface Form {
  text: string
  name: string
}

interface Snapshot {
  /** Forms by their first MIN_SECRET_LENGTH characters, longest first within each bucket. */
  index: Map<string, Form[]>
  /** mtime per watched path; -1 when the path did not exist. */
  mtimes: Map<string, number>
  status: SecretRegistryStatus
}

const BOOLEAN_OR_NULL_RE = /^(?:true|false|null)$/i
const SOPS_CIPHERTEXT_RE = /^ENC\[[^\]]*\]$/
const PEM_ARMOR_RE = /^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/

function isRegistrable(value: string): boolean {
  return (
    value.length >= MIN_SECRET_LENGTH &&
    !BOOLEAN_OR_NULL_RE.test(value) &&
    !isShellReference(value) &&
    !SOPS_CIPHERTEXT_RE.test(value) &&
    !isOnlyPlaceholders(value)
  )
}

/** A multi-line value is registered whole and line by line, so a reformatted copy is still found. */
function candidateValues(value: string): string[] {
  const whole = value.trim()
  const lines = whole.includes('\n')
    ? whole.split(/\r?\n/).map((l) => l.trim()).filter((l) => !PEM_ARMOR_RE.test(l))
    : []
  return [whole, ...lines].filter(isRegistrable)
}

interface BuiltIndex {
  index: Map<string, Form[]>
  /** Distinct values registered. */
  valueCount: number
  /** Key names whose value (or one of whose lines) is a public default and was not registered. */
  publicDefaults: string[]
  publicDefaultCount: number
}

function buildIndex(values: readonly NamedValue[], publicPasswords: ReadonlySet<string>): BuiltIndex {
  const nameByValue = new Map<string, string>()
  const publicDefaultNames = new Set<string>()
  let publicDefaultCount = 0
  for (const { name, value } of values) {
    for (const candidate of candidateValues(value)) {
      if (isCommonPassword(candidate, publicPasswords)) {
        publicDefaultCount++
        publicDefaultNames.add(name)
      } else if (!nameByValue.has(candidate)) {
        nameByValue.set(candidate, name)
      }
    }
  }
  const nameByForm = new Map<string, string>()
  for (const [value, name] of nameByValue) {
    for (const form of encodedForms(value)) {
      if (form.length >= MIN_SECRET_LENGTH && !nameByForm.has(form)) nameByForm.set(form, name)
    }
  }
  const index = new Map<string, Form[]>()
  for (const [text, name] of nameByForm) {
    const key = text.slice(0, MIN_SECRET_LENGTH)
    index.set(key, [...(index.get(key) ?? []), { text, name }])
  }
  for (const bucket of index.values()) bucket.sort((a, b) => b.text.length - a.text.length)
  return { index, valueCount: nameByValue.size, publicDefaults: [...publicDefaultNames], publicDefaultCount }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : 'error'
}

function isFormat(value: unknown): value is SourceFormat {
  return typeof value === 'string' && (SOURCE_FORMATS as readonly string[]).includes(value)
}

function parseConfig(raw: string, report: (line: string) => void): SourceEntry[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const sources = (parsed as { sources?: unknown } | null)?.sources
  if (!Array.isArray(sources)) return undefined
  return sources.flatMap((entry: unknown, i): SourceEntry[] => {
    const { path, format, exclude } = (entry ?? {}) as { path?: unknown; format?: unknown; exclude?: unknown }
    const excludes = Array.isArray(exclude) ? exclude.filter((e): e is string => typeof e === 'string') : []
    if (typeof path === 'string' && path !== '' && isFormat(format)) return [{ path, format, exclude: excludes }]
    report(`source #${i + 1} needs a "path" and one of the formats ${SOURCE_FORMATS.join(', ')}; skipped`)
    return []
  })
}

export function createSecretRegistry(options: SecretRegistryOptions): SecretRegistry {
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.warn(`[engram] secret registry: ${line}`))
  const logged = new Set<string>()
  const logOnce = (line: string): void => {
    if (logged.has(line)) return
    logged.add(line)
    log(line)
  }

  const given = options.values ?? []

  interface SourceRead {
    values: NamedValue[]
    configured: boolean
    unreadable: string[]
  }

  function readSources(configPath: string, watched: Set<string>): SourceRead {
    let raw: string
    try {
      raw = readFileSync(configPath, 'utf8')
    } catch (err) {
      logOnce(`cannot read ${configPath} (${errorCode(err)}); no known secret values from its sources are masked`)
      return { values: [], configured: false, unreadable: [configPath] }
    }
    const sources = parseConfig(raw, logOnce)
    if (sources === undefined) {
      logOnce(`${configPath} is not {"sources": [...]} JSON; no known secret values from its sources are masked`)
      return { values: [], configured: false, unreadable: [] }
    }
    const unreadable: string[] = []
    const pathCache = openGlobPathCache(options.pathCacheFile, logOnce)
    const values = sources.flatMap((source) => {
      const pattern = resolve(dirname(configPath), expandHome(source.path))
      const expansion = pathCache.expand(pattern, source.exclude)
      expansion.watched.forEach((p) => watched.add(p))
      if (expansion.truncated) logOnce(`${source.path}: glob walk stopped early; narrow the pattern`)
      const unnamed: string[] = []
      const values = expansion.files.flatMap((file) => {
        watched.add(file)
        let content: string
        try {
          content = readFileSync(file, 'utf8')
        } catch (err) {
          logOnce(`${file}: unreadable (${errorCode(err)}); skipped`)
          unreadable.push(file)
          return []
        }
        const parsed = parseSource(source.format, content, file)
        if ('unnamed' in parsed) unnamed.push(basename(file))
        if ('skipped' in parsed) logOnce(`${file}: ${parsed.skipped}; skipped`)
        return 'values' in parsed ? parsed.values : []
      })
      if (unnamed.length > 0) {
        logOnce(`${source.path}: not registered, the file name names no credential: ${unnamed.join(', ')}`)
      }
      return values
    })
    pathCache.save()
    return { values, configured: true, unreadable }
  }

  function indexOf(values: readonly NamedValue[]): BuiltIndex {
    const built = buildIndex(values, commonPasswords(logOnce))
    if (built.publicDefaultCount > 0) {
      logOnce(
        `${built.publicDefaultCount} publicly known default value(s) not registered, under: ${built.publicDefaults.join(', ')}`,
      )
    }
    return built
  }

  function snapshotOf(read: SourceRead, mtimes: Map<string, number>): Snapshot {
    // Given values come first, so a value also found in a source keeps the name its holder gave it.
    const built = indexOf([...given, ...read.values])
    return {
      index: built.index,
      mtimes,
      status: { configured: read.configured, unreadable: read.unreadable, values: built.valueCount },
    }
  }

  function build(): Snapshot {
    const none: SourceRead = { values: [], configured: false, unreadable: [] }
    if (options.configPath === undefined || options.configPath === '') {
      logOnce(`${SECRET_SOURCES_ENV} is unset; no known secret values from sources are masked`)
      return snapshotOf(none, new Map())
    }
    const configPath = resolve(expandHome(options.configPath))
    const watched = new Set([configPath])
    const mtimes = (): Map<string, number> => new Map([...watched].map((p) => [p, mtimeOf(p)]))
    try {
      const read = readSources(configPath, watched)
      return snapshotOf(read, mtimes())
    } catch (err) {
      // Report the error's class only: its message may quote a source file.
      logOnce(`building the registry failed (${err instanceof Error ? err.name : 'error'}); no known secret values from sources are masked`)
      return snapshotOf({ ...none, unreadable: [configPath] }, mtimes())
    }
  }

  let snapshot: Snapshot | undefined
  let checkedAt = 0

  function current(): Snapshot {
    const t = now()
    if (snapshot === undefined) {
      snapshot = build()
      checkedAt = t
      return snapshot
    }
    if (t - checkedAt < RECHECK_INTERVAL_MS) return snapshot
    checkedAt = t
    const stale = [...snapshot.mtimes].some(([path, mtime]) => mtimeOf(path) !== mtime)
    if (stale) snapshot = build()
    return snapshot
  }

  function findKnownValues(text: string): KnownValueSpan[] {
    const { index } = current()
    if (index.size === 0 || text.length < MIN_SECRET_LENGTH) return []
    const placeholders = placeholderRanges(text)
    const spans: KnownValueSpan[] = []
    let p = 0
    for (let i = 0; i + MIN_SECRET_LENGTH <= text.length; i++) {
      const bucket = index.get(text.slice(i, i + MIN_SECRET_LENGTH))
      if (bucket === undefined) continue
      const form = bucket.find((f) => text.startsWith(f.text, i))
      if (form === undefined) continue
      const end = i + form.text.length
      while (p < placeholders.length && placeholders[p]![1] <= i) p++
      const inPlaceholder = p < placeholders.length && placeholders[p]![0] <= i && end <= placeholders[p]![1]
      if (!inPlaceholder) spans.push({ start: i, end, name: form.name })
    }
    return spans
  }

  function status(): SecretRegistryStatus {
    const { status: s } = current()
    return { configured: s.configured, unreadable: [...s.unreadable], values: s.values }
  }

  return { findKnownValues, status }
}

let defaultRegistry: SecretRegistry | undefined

/**
 * Credentials the server process itself holds. Text sent to it may quote any
 * of them (a pasted config, a curl line), so each one that is set is masked
 * under its variable's name. Values shorter than MIN_SECRET_LENGTH and
 * publicly known defaults are skipped as for any source.
 */
export const PROCESS_SECRET_ENV_NAMES = [
  'SUPABASE_KEY',
  'SUPABASE_SERVICE_KEY',
  'OPENAI_API_KEY',
  'BEARER_TOKEN',
  'ENGRAM_CAPTURE_TOKEN',
  'ENGRAM_DOCUMENTS_TOKEN',
  'NEO4J_PASSWORD',
  'ENGRAM_CHAT_API_KEY',
  'ENGRAM_SERVER_TOKEN',
] as const

function processSecretValues(): NamedValue[] {
  return PROCESS_SECRET_ENV_NAMES.flatMap((name) => {
    const value = process.env[name]
    return value !== undefined && value !== '' ? [{ name, value }] : []
  })
}

function defaultPathCacheFile(): string {
  const cacheHome = process.env.XDG_CACHE_HOME
  const base = cacheHome !== undefined && isAbsolute(cacheHome) ? cacheHome : join(homedir(), '.cache')
  return join(base, 'engram', 'secret-source-paths.json')
}

/**
 * The process-wide registry: the sources `ENGRAM_SECRET_SOURCES_FILE` names
 * plus the process's own credentials, created on first use.
 */
export function defaultSecretRegistry(): SecretRegistry {
  defaultRegistry ??= createSecretRegistry({
    configPath: process.env[SECRET_SOURCES_ENV],
    pathCacheFile: defaultPathCacheFile(),
    values: processSecretValues(),
  })
  return defaultRegistry
}

/** Drops the process-wide registry so the next use reads `ENGRAM_SECRET_SOURCES_FILE` again. */
export function resetDefaultSecretRegistry(): void {
  defaultRegistry = undefined
}
