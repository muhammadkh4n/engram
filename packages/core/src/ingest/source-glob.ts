/**
 * Expands a secret source path that may be a glob: `*`, `?`, `[…]`, `{a,b}`
 * and `**`. Written against `readdirSync` rather than `fs.globSync` so it runs
 * on Node 20, and so the walk can report every directory it read: a change to
 * any of them (a new `.env` in a project) is what tells the registry to
 * rebuild. `node_modules` and `.git` are never entered, symlinked directories
 * are not followed under `**` (no cycles), and wildcards skip dot-entries
 * unless the pattern segment itself starts with a dot.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const PRUNED_DIRS = new Set(['node_modules', '.git'])
const GLOB_CHARS_RE = /[*?[{]/
const MAX_BRACE_EXPANSIONS = 64
// The walk runs synchronously on the ingest path; a pattern as broad as
// `~/**` stops here instead of blocking the process for minutes.
export const MAX_GLOB_DIRS = 20_000

export interface GlobExpansion {
  files: string[]
  /** Directories read and paths looked up; their mtimes decide when to expand again. */
  watched: string[]
  truncated: boolean
}

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Bash-style brace expansion: `{a,b}c` → `ac`, `bc`. */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  let depth = 0
  const commas: number[] = []
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\') i++
    else if (ch === '{') depth++
    else if (ch === ',' && depth === 1) commas.push(i)
    else if (ch === '}' && --depth === 0) {
      if (commas.length === 0) break
      const bounds = [open, ...commas, i]
      const head = pattern.slice(0, open)
      const tail = pattern.slice(i + 1)
      const out: string[] = []
      for (let k = 0; k + 1 < bounds.length && out.length < MAX_BRACE_EXPANSIONS; k++) {
        const alternative = pattern.slice(bounds[k]! + 1, bounds[k + 1])
        out.push(...expandBraces(head + alternative + tail))
      }
      return out.slice(0, MAX_BRACE_EXPANSIONS)
    }
  }
  // No closing brace or no comma: the `{` is literal; expand what follows it.
  const rest = expandBraces(pattern.slice(open + 1))
  return rest.map((r) => pattern.slice(0, open + 1) + r)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** Regex source for one path segment (no `/`, no braces). */
function segmentSource(segment: string): string {
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (ch === '\\' && i + 1 < segment.length) {
      out += escapeRegExp(segment[++i]!)
    } else if (ch === '*') {
      out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '[') {
      const close = segment.indexOf(']', i + 2)
      if (close === -1) {
        out += '\\['
        continue
      }
      let body = segment.slice(i + 1, close)
      const negated = body.startsWith('!') || body.startsWith('^')
      if (negated) body = body.slice(1)
      out += `[${negated ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
      i = close
    } else {
      out += escapeRegExp(ch)
    }
  }
  return out
}

function segmentMatcher(segment: string): (name: string) => boolean {
  const re = new RegExp(`^${segmentSource(segment)}$`)
  const allowDot = segment.startsWith('.')
  return (name) => (allowDot || !name.startsWith('.')) && re.test(name)
}

/**
 * Exclude patterns match whole absolute paths; a relative one matches at any
 * depth (`**` + `/` + pattern). A directory matching an exclude is not entered.
 */
export function excludeMatcher(patterns: readonly string[]): (path: string) => boolean {
  const regexes = patterns.flatMap(expandBraces).map((p) => {
    const expanded = expandHome(p)
    const anchored = isAbsolute(expanded) ? expanded : `**/${expanded}`
    const segments = anchored.split('/')
    let source = ''
    segments.forEach((segment, i) => {
      const last = i === segments.length - 1
      if (segment === '**') source += last ? '.*' : '(?:[^/]*/)*'
      else source += segmentSource(segment) + (last ? '' : '/')
    })
    return new RegExp(`^${source}$`)
  })
  return (path) => regexes.some((re) => re.test(path) || re.test(`${path}/`))
}

type EntryKind = 'file' | 'dir' | 'other'

function statKind(path: string): EntryKind | undefined {
  try {
    const st = statSync(path)
    return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
  } catch {
    return undefined
  }
}

function entryKind(entry: Dirent, path: string): EntryKind | undefined {
  if (entry.isFile()) return 'file'
  if (entry.isDirectory()) return 'dir'
  return entry.isSymbolicLink() ? statKind(path) : 'other'
}

class Walk {
  readonly files = new Set<string>()
  readonly watched = new Set<string>()
  truncated = false
  private dirsRead = 0

  constructor(
    private readonly segments: readonly string[],
    private readonly isExcluded: (path: string) => boolean,
  ) {}

  private read(dir: string): Dirent[] | undefined {
    this.watched.add(dir)
    if (this.dirsRead >= MAX_GLOB_DIRS) {
      this.truncated = true
      return undefined
    }
    this.dirsRead++
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      return undefined
    }
  }

  private enter(path: string, name: string, kind: EntryKind | undefined, next: number): void {
    const last = next === this.segments.length
    if (last) {
      if (kind === 'file') this.files.add(path)
    } else if (kind === 'dir' && !PRUNED_DIRS.has(name)) {
      this.walk(path, next)
    }
  }

  walk(dir: string, index: number): void {
    const entries = this.read(dir)
    if (!entries) return
    const segment = this.segments[index]!
    if (segment !== '**') {
      this.matchSegment(dir, entries, index)
      return
    }
    if (index + 1 < this.segments.length) this.matchSegment(dir, entries, index + 1)
    for (const entry of entries) {
      if (entry.name.startsWith('.') || PRUNED_DIRS.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (this.isExcluded(path)) continue
      if (entry.isDirectory()) this.walk(path, index)
      else if (index + 1 === this.segments.length && entryKind(entry, path) === 'file') this.files.add(path)
    }
  }

  private matchSegment(dir: string, entries: readonly Dirent[], index: number): void {
    const segment = this.segments[index]!
    if (!GLOB_CHARS_RE.test(segment)) {
      const path = join(dir, segment)
      if (!this.isExcluded(path)) this.enter(path, segment, statKind(path), index + 1)
      return
    }
    const matches = segmentMatcher(segment)
    for (const entry of entries) {
      if (!matches(entry.name)) continue
      const path = join(dir, entry.name)
      if (this.isExcluded(path)) continue
      this.enter(path, entry.name, entryKind(entry, path), index + 1)
    }
  }
}

/** Files an absolute pattern names, in sorted order. */
export function expandGlob(pattern: string, isExcluded: (path: string) => boolean): GlobExpansion {
  const files = new Set<string>()
  const watched = new Set<string>()
  let truncated = false
  for (const expanded of expandBraces(pattern)) {
    const absolute = resolve(expanded)
    // `a/**/**/b` is `a/**/b`.
    const segments = absolute.split('/').filter((s, i, all) => !(s === '**' && all[i - 1] === '**'))
    const firstGlob = segments.findIndex((s) => GLOB_CHARS_RE.test(s))
    if (firstGlob === -1) {
      watched.add(absolute)
      if (!isExcluded(absolute) && statKind(absolute) === 'file') files.add(absolute)
      continue
    }
    const base = segments.slice(0, firstGlob).join('/') || '/'
    const walk = new Walk(segments, isExcluded)
    walk.walk(base, firstGlob)
    walk.files.forEach((f) => files.add(f))
    walk.watched.forEach((w) => watched.add(w))
    truncated ||= walk.truncated
  }
  return { files: [...files].sort(), watched: [...watched], truncated }
}

const PATH_CACHE_VERSION = 1

interface CachedExpansion {
  files: string[]
  truncated: boolean
  /** Every watched path with the mtime it had when the walk ran; -1 when it did not exist. */
  watched: Array<[string, number]>
}

function mtimeOrMissing(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

function isCachedExpansion(value: unknown): value is CachedExpansion {
  const v = value as Partial<CachedExpansion> | null
  return (
    v !== null &&
    typeof v === 'object' &&
    Array.isArray(v.files) &&
    typeof v.truncated === 'boolean' &&
    Array.isArray(v.watched) &&
    v.watched.every((w) => Array.isArray(w) && typeof w[0] === 'string' && typeof w[1] === 'number')
  )
}

export interface GlobPathCache {
  /** Expands `pattern`, reusing the last walk while every directory it read keeps its mtime. */
  expand(pattern: string, excludes: readonly string[]): GlobExpansion
  /** Writes the walks done since opening, when any were, to the cache file. */
  save(): void
}

/**
 * A walk under a broad pattern (`~/projects/**\/.env*`) reads thousands of
 * directories; a new file changes its directory's mtime, so while every
 * directory a walk read keeps its mtime, the walk's result still holds and
 * one stat per directory replaces one readdir. The cache holds paths and
 * mtimes only, never file contents, in a file only its owner can read.
 * `cacheFile` undefined disables it; any cache I/O failure falls back to
 * walking, reported through `report` with the error code only.
 */
export function openGlobPathCache(cacheFile: string | undefined, report: (line: string) => void): GlobPathCache {
  const entries = new Map<string, CachedExpansion>()
  if (cacheFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf8')) as { version?: unknown; entries?: unknown }
      if (parsed.version === PATH_CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
        for (const [key, value] of Object.entries(parsed.entries)) if (isCachedExpansion(value)) entries.set(key, value)
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ENOENT' && !(err instanceof SyntaxError)) report(`path cache unreadable (${code ?? 'error'}); walking`)
    }
  }
  let dirty = false

  function expand(pattern: string, excludes: readonly string[]): GlobExpansion {
    // A literal path costs one stat either way; only walks are worth caching.
    const cacheable = cacheFile !== undefined && GLOB_CHARS_RE.test(pattern)
    const key = JSON.stringify([pattern, excludes])
    const cached = cacheable ? entries.get(key) : undefined
    if (cached !== undefined && cached.watched.every(([path, mtime]) => mtimeOrMissing(path) === mtime)) {
      return { files: cached.files, watched: cached.watched.map(([path]) => path), truncated: cached.truncated }
    }
    const expansion = expandGlob(pattern, excludeMatcher(excludes))
    if (cacheable) {
      entries.set(key, {
        files: expansion.files,
        truncated: expansion.truncated,
        watched: expansion.watched.map((path) => [path, mtimeOrMissing(path)]),
      })
      dirty = true
    }
    return expansion
  }

  function save(): void {
    if (cacheFile === undefined || !dirty) return
    dirty = false
    const tmp = `${cacheFile}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 })
      writeFileSync(tmp, JSON.stringify({ version: PATH_CACHE_VERSION, entries: Object.fromEntries(entries) }), {
        mode: 0o600,
      })
      renameSync(tmp, cacheFile)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      report(`path cache not written (${code ?? 'error'})`)
    }
  }

  return { expand, save }
}
