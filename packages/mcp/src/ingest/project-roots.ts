/**
 * Configured project roots: directories that name a project even though they
 * are not inside a git repository (a multi-repo workspace folder, say).
 *
 * They live in the project-groups file (ENGRAM_PROJECT_GROUPS_FILE) next to
 * the ranking groups:
 *   { "groups": { ... }, "roots": { "<absolute dir>": "<project>" } }
 * The server's groups parser reads only `groups`; this loader reads only
 * `roots`.
 *
 * Capture must never fail because of this file: an unreadable or malformed
 * file, a non-object `roots`, a relative key or a non-string value is skipped,
 * and the first such problem is reported once per process on stderr.
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

export interface ProjectRoot {
  /** Absolute directory, normalised with path.resolve (symlinks not followed). */
  readonly dir: string
  readonly project: string
}

let warned = false

function warnOnce(message: string): void {
  if (warned) return
  warned = true
  console.warn(`[engram] project roots: ${message}`)
}

/** Allow the next problem to be reported again (tests). */
export function resetProjectRootsWarning(): void {
  warned = false
}

/** Parse the `roots` object of a groups document, skipping bad entries. */
export function parseProjectRoots(doc: unknown, origin = 'project groups file'): ProjectRoot[] {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    warnOnce(`${origin} is not a JSON object; roots ignored`)
    return []
  }
  const raw = (doc as Record<string, unknown>)['roots']
  if (raw === undefined) return []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnOnce(`"roots" in ${origin} must be an object; roots ignored`)
    return []
  }
  const roots: ProjectRoot[] = []
  for (const [dir, project] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAbsolute(dir)) {
      warnOnce(`root "${dir}" in ${origin} is not an absolute path; skipped`)
      continue
    }
    if (typeof project !== 'string' || project.trim() === '') {
      warnOnce(`root "${dir}" in ${origin} must map to a non-empty string; skipped`)
      continue
    }
    roots.push({ dir: resolve(dir), project: project.trim() })
  }
  return roots
}

/** Roots from `filePath`; an unset path means none, a bad file means none plus one warning. */
export function loadProjectRoots(filePath: string | undefined): ProjectRoot[] {
  if (!filePath) return []
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (err) {
    warnOnce(`${filePath} ignored: ${(err as Error).message}`)
    return []
  }
  return parseProjectRoots(doc, filePath)
}

function isWithin(path: string, dir: string): boolean {
  if (path === dir) return true
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  return path.startsWith(prefix)
}

/**
 * The project of the longest root containing `cwd`, matched on whole path
 * segments (`/a/b` contains `/a/b/c`, not `/a/bc`), or null.
 */
export function projectForRoot(cwd: string, roots: readonly ProjectRoot[]): string | null {
  const path = resolve(cwd)
  let best: ProjectRoot | null = null
  for (const root of roots) {
    if (!isWithin(path, root.dir)) continue
    if (!best || root.dir.length > best.dir.length) best = root
  }
  return best?.project ?? null
}
