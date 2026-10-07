/**
 * Replays a user's own commit history as `git_commit` capture events.
 *
 * Each event is built by the post-commit hook's own builder for that sha, so
 * its session, event uuid, message and files are the ones the hook sends,
 * and a commit the hook already captured comes back as a duplicate. Only a
 * repository the project registry holds is read, only its default branch,
 * as the local clone knows it: nothing is fetched. Merge commits are left
 * out; a squash commit is an ordinary commit and is kept.
 */

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ProjectRegistry } from '../capture-events/project-registry.js'
import { buildGitCommitEvent } from '../capture/git-commit-event.js'
import type { CaptureEvent } from '../capture/events.js'
import { detectCheckout } from '../ingest/project-detect.js'
import { countPrepared, emptyTally, prepareEvents, sendSession, type SendTally, type SendTarget } from './send.js'

type Env = Record<string, string | undefined>

/** Larger than any commit list git prints for one repository. */
const GIT_OUTPUT_MAX_BYTES = 256 * 1024 * 1024
/** Local branches tried in order when the clone has no `origin/HEAD`. */
const FALLBACK_BRANCHES = ['main', 'master', 'develop'] as const
const ORIGIN_PREFIX = 'refs/remotes/origin/'
const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g

export interface GitOptions {
  env: Env
  /** Checkouts named one by one. */
  repos: readonly string[]
  /** Directories whose immediate children with a `.git` directory are read. */
  reposUnder: readonly string[]
  /** The authors whose commits are sent; each repository's `user.email` when empty. */
  authorEmails: readonly string[]
  /** Only commits after this time, as `git log --since` reads it. */
  since: string | null
  registry: ProjectRegistry
  /** The registry file, handed to the hook's builder for each event's project block. */
  registryFile: string
  /** Absent for a dry run, which sends nothing and writes no state. */
  send?: SendTarget
  now?: () => Date
  log?: (line: string) => void
}

export interface GitRepoRun {
  path: string
  repo: string
  /** The default branch read, and the ref that names it. */
  branch: string
  ref: string
  authors: string[]
  commits: number
}

export type GitSkipReason = 'not-a-repository' | 'unregistered' | 'duplicate-repository' | 'no-default-branch' | 'no-author-email'

export interface GitSummary extends SendTally {
  command: 'git'
  apply: boolean
  repos: GitRepoRun[]
  skipped: Array<{ path: string; repo: string | null; reason: GitSkipReason }>
  /** Shas the hook's builder could not read; never sent. */
  unreadable: number
  /** Why the run stopped before the last repository, or null. */
  stopped: string | null
}

/** git's stdout, or null when it exits non-zero: every call here asks a question a non-zero exit answers. */
function gitOutput(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: GIT_OUTPUT_MAX_BYTES }).toString('utf8')
  } catch (err) {
    if (typeof (err as { status?: unknown }).status === 'number') return null
    throw err
  }
}

/** `origin/HEAD`'s target, else the first of main, master and develop that exists. */
export function defaultBranch(repoPath: string): { branch: string; ref: string } | null {
  const origin = gitOutput(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])?.trim()
  if (origin?.startsWith(ORIGIN_PREFIX) && gitOutput(repoPath, ['rev-parse', '--verify', '--quiet', `${origin}^{commit}`])) {
    return { branch: origin.slice(ORIGIN_PREFIX.length), ref: origin }
  }
  for (const name of FALLBACK_BRANCHES) {
    const ref = `refs/heads/${name}`
    if (gitOutput(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null) return { branch: name, ref }
  }
  return null
}

function configuredEmail(repoPath: string): string[] {
  const email = gitOutput(repoPath, ['config', 'user.email'])?.trim()
  return email ? [email] : []
}

/**
 * The non-merge commits on `ref` by any of `authors`, oldest first. `--author`
 * is a regex over `Name <email>`, so each email is escaped and anchored in
 * its angle brackets, and the author email is compared exactly afterwards.
 */
export function authoredShas(repoPath: string, ref: string, authors: readonly string[], since: string | null): string[] {
  const wanted = new Set(authors.map((a) => a.toLowerCase()))
  const args = [
    'log',
    '--no-merges',
    '--format=%H%x09%ae',
    ...authors.map((a) => `--author=<${a.replace(REGEX_META_RE, '\\$&')}>`),
    ...(since === null ? [] : [`--since=${since}`]),
    ref,
    '--',
  ]
  const out = gitOutput(repoPath, args)
  if (out === null) throw new Error(`git log failed in ${repoPath}`)
  return out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([sha, email]) => sha && email !== undefined && wanted.has(email.toLowerCase()))
    .map(([sha]) => sha!)
    .reverse()
}

/** The checkouts to read: each `--repo`, then each child of a `--repos-under` dir whose `.git` is a directory. */
async function candidatePaths(opts: GitOptions): Promise<string[]> {
  const paths = opts.repos.map((p) => resolve(p))
  for (const dir of opts.reposUnder) {
    const children = (await fs.readdir(resolve(dir), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    for (const name of children) {
      const path = join(resolve(dir), name)
      const stat = await fs.stat(join(path, '.git')).catch(() => null)
      if (stat?.isDirectory()) paths.push(path)
    }
  }
  return [...new Set(paths)]
}

/** What one repository yields, or why it is skipped. */
function planRepo(
  path: string,
  opts: GitOptions,
  seen: Set<string>,
): { run: GitRepoRun; shas: string[] } | { skip: GitSummary['skipped'][number] } {
  const repo = detectCheckout(path)?.repo ?? null
  if (repo === null) return { skip: { path, repo, reason: 'not-a-repository' } }
  if (!opts.registry.projects.has(repo)) return { skip: { path, repo, reason: 'unregistered' } }
  if (seen.has(repo)) return { skip: { path, repo, reason: 'duplicate-repository' } }
  const branch = defaultBranch(path)
  if (branch === null) return { skip: { path, repo, reason: 'no-default-branch' } }
  const authors = opts.authorEmails.length > 0 ? [...opts.authorEmails] : configuredEmail(path)
  if (authors.length === 0) return { skip: { path, repo, reason: 'no-author-email' } }
  seen.add(repo)
  const shas = authoredShas(path, branch.ref, authors, opts.since)
  return { run: { path, repo, ...branch, authors, commits: shas.length }, shas }
}

export async function runGit(opts: GitOptions): Promise<GitSummary> {
  const now = opts.now ?? (() => new Date())
  const log = opts.log ?? (() => {})
  const summary: GitSummary = {
    command: 'git',
    apply: opts.send !== undefined,
    repos: [],
    skipped: [],
    unreadable: 0,
    ...emptyTally(),
    stopped: null,
  }
  const builderEnv: Env = { ...opts.env, ENGRAM_PROJECT_REGISTRY_FILE: opts.registryFile }
  const seen = new Set<string>()
  for (const path of await candidatePaths(opts)) {
    const planned = planRepo(path, opts, seen)
    if ('skip' in planned) {
      summary.skipped.push(planned.skip)
      continue
    }
    summary.repos.push(planned.run)
    const events: CaptureEvent[] = []
    for (const sha of planned.shas) {
      const event = buildGitCommitEvent(path, sha, { env: builderEnv })
      if (event === null) summary.unreadable++
      else events.push(event)
    }
    const prepared = await prepareEvents(events, { now: now(), log })
    if (opts.send === undefined) {
      countPrepared(summary, prepared)
      continue
    }
    const outcome = await sendSession(opts.send, `git:${planned.run.repo}`, prepared, summary)
    if (!outcome.delivered) {
      summary.stopped = outcome.stopped
      break
    }
  }
  return summary
}
