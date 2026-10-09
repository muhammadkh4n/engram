/**
 * One git commit as a raw `git_commit` capture event: the full sha, the
 * commit object's message byte for byte, the files it touched, and its
 * author and committer dates. The post-commit hook builds one for HEAD; a
 * backfill can build one for any older revision.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { type CaptureEventOf, GIT_FILES_MAX } from '../capture-events/contract.js'
import { detectCheckout } from '../ingest/project-detect.js'
import { loadCaptureRegistry, resolveEventProject } from './event-project.js'
import { appendCaptureLog } from './log.js'
import { eventUuidFromParts } from './event-uuid.js'

type Env = Record<string, string | undefined>

/** Larger than any commit's message or file list the route accepts, so git output is never cut short. */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024

export interface BuildGitCommitEventOptions {
  /** Supplies ENGRAM_PROJECT_REGISTRY_FILE and HOME for the project block; process.env by default. */
  env?: Env
}

/** A git call that did not exit 0: its subcommand and exit code (null when killed or never run). */
class GitCallError extends Error {
  constructor(
    readonly subcommand: string,
    readonly status: number | null,
    readonly detail: string,
  ) {
    super(`git ${subcommand} ${status === null ? `failed: ${detail}` : `exited ${status}`}`)
    this.name = 'GitCallError'
  }
}

function git(cwd: string, args: readonly string[]): Buffer {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: GIT_OUTPUT_MAX_BYTES,
    })
  } catch (err) {
    const e = err as { status?: unknown; signal?: unknown; code?: unknown }
    const detail = typeof e.signal === 'string' ? e.signal : typeof e.code === 'string' ? e.code : 'error'
    throw new GitCallError(args[0] ?? '', typeof e.status === 'number' ? e.status : null, detail)
  }
}

function gitText(cwd: string, args: readonly string[]): string {
  return git(cwd, args).toString('utf8').trim()
}

/** The capture-log line for a failed build: the git call and its exit code, never the revision, message or file names. */
function failureLine(err: unknown): string {
  if (err instanceof GitCallError) return `git-commit event: ${err.message}`
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return `git-commit event failed: ${typeof code === 'string' ? code : err instanceof Error ? err.name : 'error'}`
}

/**
 * The checked-out branch, or null on a detached HEAD, where `symbolic-ref`
 * exits 1. `symbolic-ref` runs on every git; `branch --show-current` needs 2.22.
 */
function currentBranch(dir: string): string | null {
  try {
    return gitText(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null
  } catch (err) {
    if (err instanceof GitCallError && err.status === 1) return null
    throw err
  }
}

/**
 * The full sha `rev` names, or null when it names no commit: `rev-parse
 * --verify --quiet` exits 1 for an unknown revision and on an unborn HEAD,
 * which is an answer, not a git failure. Any other exit still throws.
 */
function resolveCommit(dir: string, rev: string): string | null {
  try {
    return gitText(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) || null
  } catch (err) {
    if (err instanceof GitCallError && err.status === 1) return null
    throw err
  }
}

/**
 * The files `sha` changed, NUL-separated so names stay byte-exact. A merge
 * is diffed against its first parent with a plain two-tree diff, which every
 * git version runs; the default combined diff would list nothing for it.
 */
function changedFiles(dir: string, sha: string, parents: readonly string[]): string[] {
  const args =
    parents.length > 1
      ? ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', parents[0]!, sha]
      : ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-z', sha]
  return git(dir, args)
    .toString('utf8')
    .split('\0')
    .filter((f) => f.length > 0)
    .slice(0, GIT_FILES_MAX)
}

/**
 * The message of a raw commit object: everything after the header's
 * terminating blank line, less the one newline git appends. Header
 * continuation lines (a signature, a mergetag) start with a space, so the
 * first empty line always ends the header.
 */
export function commitObjectMessage(raw: string): string | null {
  const end = raw.indexOf('\n\n')
  if (end < 0) return null
  const message = raw.slice(end + 2)
  return message.endsWith('\n') ? message.slice(0, -1) : message
}

/**
 * The `git_commit` event for `rev` in the repository holding `cwd`, or null
 * outside a repository, for a revision that names no readable commit, and
 * for a blank message, which the capture route refuses. The session is
 * `git:<repo>`, and the event uuid depends on the repository and sha only,
 * so the same commit captured twice is one event.
 */
export function buildGitCommitEvent(
  cwd: string,
  rev = 'HEAD',
  opts: BuildGitCommitEventOptions = {},
): CaptureEventOf<'git_commit'> | null {
  const dir = resolve(cwd)
  const checkout = detectCheckout(dir)
  if (checkout === null || rev.length === 0 || rev.startsWith('-')) return null
  try {
    const sha = resolveCommit(dir, rev)
    if (sha === null) return null
    const message = commitObjectMessage(git(dir, ['cat-file', 'commit', sha]).toString('utf8'))
    if (message === null || message.trim().length === 0) return null
    const [authoredAt, committedAt, parentLine = ''] = gitText(dir, ['show', '-s', '--format=%aI%n%cI%n%P', sha]).split('\n')
    if (!authoredAt || !committedAt) return null
    const files = changedFiles(dir, sha, parentLine.split(' ').filter((p) => p.length > 0))
    const branch = currentBranch(dir)
    const repo = checkout.repo
    return {
      session_id: `git:${repo}`,
      event_uuid: eventUuidFromParts('git_commit', repo, sha),
      type: 'git_commit',
      occurred_at: committedAt,
      cwd: dir,
      project: resolveEventProject(dir, branch, loadCaptureRegistry(opts.env ?? process.env)),
      plan_dirs: [],
      payload: { repo, sha, message, files, authored_at: authoredAt },
    }
  } catch (err) {
    appendCaptureLog(opts.env ?? process.env, failureLine(err))
    return null
  }
}
