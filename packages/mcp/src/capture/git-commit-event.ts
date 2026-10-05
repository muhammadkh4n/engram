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
import { eventUuidFromParts } from './event-uuid.js'

type Env = Record<string, string | undefined>

/** Larger than any commit's message or file list the route accepts, so git output is never cut short. */
const GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024

export interface BuildGitCommitEventOptions {
  /** Supplies ENGRAM_PROJECT_REGISTRY_FILE and HOME for the project block; process.env by default. */
  env?: Env
}

function git(cwd: string, args: readonly string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  })
}

function gitText(cwd: string, args: readonly string[]): string {
  return git(cwd, args).toString('utf8').trim()
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
    const sha = gitText(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    if (!sha) return null
    const message = commitObjectMessage(git(dir, ['cat-file', 'commit', sha]).toString('utf8'))
    if (message === null || message.trim().length === 0) return null
    const [authoredAt, committedAt] = gitText(dir, ['show', '-s', '--format=%aI%n%cI', sha]).split('\n')
    if (!authoredAt || !committedAt) return null
    const files = git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-z', sha])
      .toString('utf8')
      .split('\0')
      .filter((f) => f.length > 0)
      .slice(0, GIT_FILES_MAX)
    const branch = gitText(dir, ['branch', '--show-current']) || null
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
  } catch {
    return null
  }
}
