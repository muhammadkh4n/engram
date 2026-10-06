/**
 * git commits as raw capture events: the commit read from a real temporary
 * repository, and the post-commit capture spooling it. No server URL is set,
 * so the spooled batch stays where the test reads it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { buildGitCommitEvent, commitObjectMessage } from '../../src/capture/git-commit-event.js'
import { eventUuidFromParts } from '../../src/capture/event-uuid.js'
import { captureLogPath } from '../../src/capture/log.js'
import { spoolRoot } from '../../src/capture/spool.js'
import { runGitCommitCapture } from '../../src/hooks/git-commit.js'

const AUTHORED = '2026-10-01T09:15:00+02:00'
const COMMITTED = '2026-10-02T17:40:05+02:00'

let root: string
let env: Record<string, string>

/** Hooks are disabled so a machine-wide post-commit hook never fires on test commits. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: AUTHORED, GIT_COMMITTER_DATE: COMMITTED },
  })
}

/** Commits exactly `message` (no cleanup) after writing `files`. */
function commit(cwd: string, message: string, files: Record<string, string> = {}, ...extra: string[]): string {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(cwd, name, '..'), { recursive: true })
    writeFileSync(join(cwd, name), body)
    git(cwd, 'add', '--', name)
  }
  const msgFile = join(root, 'msg.txt')
  writeFileSync(msgFile, message)
  git(cwd, 'commit', '-q', '--allow-empty', '--cleanup=verbatim', '-F', msgFile, ...extra)
  return git(cwd, 'rev-parse', 'HEAD').trim()
}

function initRepo(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  return dir
}

/**
 * Runs `fn` with a `git` first on PATH that records each call's arguments in
 * `calls` and runs the real git, or, with `failDiffTree`, exits 129 (git's
 * code for an unknown option) on `diff-tree`.
 */
function withGitWrapper<T>(calls: string, failDiffTree: boolean, fn: () => T): T {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const bin = join(root, 'git-wrapper-bin')
  mkdirSync(bin, { recursive: true })
  const fail = failDiffTree ? `[ "$1" = diff-tree ] && exit 129\n` : ''
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n${fail}exec '${realGit}' "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`
  try {
    return fn()
  } finally {
    process.env.PATH = savedPath
  }
}

/** Points the env at an empty, valid project registry, so a built event writes no registry line to capture.log. */
function useEmptyRegistry(): void {
  mkdirSync(env.HOME!, { recursive: true })
  writeFileSync(join(env.HOME!, 'registry.json'), JSON.stringify({ version: 1, workspaces: {}, projects: {} }))
  env.ENGRAM_PROJECT_REGISTRY_FILE = '~/registry.json'
}

/** The capture.log lines written so far; none when the file was never created. */
function captureLogLines(): string[] {
  const path = captureLogPath(env)
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'engram-git-commit-')))
  env = { HOME: join(root, 'home') }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('commitObjectMessage', () => {
  it('takes everything after the header and drops only the final newline', () => {
    const raw = 'tree abc\nauthor A <a@x> 1 +0000\ngpgsig -----BEGIN-----\n \n -----END-----\n\nsubject\n\nbody\n\n'
    expect(commitObjectMessage(raw)).toBe('subject\n\nbody\n')
  })

  it('gives null for an object without a message separator', () => {
    expect(commitObjectMessage('tree abc\nauthor A <a@x> 1 +0000\n')).toBeNull()
  })
})

describe('buildGitCommitEvent', () => {
  it('keeps a message with a body and trailers byte for byte', () => {
    const repo = initRepo('engram')
    const message =
      'feat: capture commits raw\n\nThe body keeps  double spaces,\n\tleading tabs and non-ASCII text: café — ok.\n\n' +
      'Signed-off-by: Test <test@example.com>\nReviewed-by: Other <other@example.com>\n'
    const sha = commit(repo, message, { 'a.txt': 'a\n' })

    const event = buildGitCommitEvent(repo, 'HEAD', { env })

    expect(event).not.toBeNull()
    expect(event!.payload.message).toBe(message.slice(0, -1))
    expect(event!.payload.sha).toBe(sha)
    expect(event!.payload.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(event!.payload.authored_at).toBe(AUTHORED)
    expect(event!.occurred_at).toBe(COMMITTED)
    expect(event!.session_id).toBe('git:engram')
    expect(event!.type).toBe('git_commit')
    expect(event!.plan_dirs).toEqual([])
    expect(event!.project).toMatchObject({ id: 'engram', repo_root: repo, branch: 'main', worktree: null })
  })

  it('lists the files a commit touched, and a root commit lists its files', () => {
    const repo = initRepo('engram')
    commit(repo, 'root commit\n', { 'README.md': 'x\n', 'src/a.ts': 'a\n' })
    const rootEvent = buildGitCommitEvent(repo, 'HEAD', { env })
    expect(rootEvent!.payload.files).toEqual(['README.md', 'src/a.ts'])

    commit(repo, 'second\n', { 'src/b.ts': 'b\n', 'src/a.ts': 'a2\n' })
    expect(buildGitCommitEvent(repo, 'HEAD', { env })!.payload.files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('a conflicted merge, resolved and committed, lists the files it changed against its first parent', () => {
    const repo = initRepo('engram')
    commit(repo, 'base\n', { 'shared.txt': 'base\n', 'kept.txt': 'kept\n' })
    git(repo, 'switch', '-q', '-c', 'topic')
    commit(repo, 'topic side\n', { 'shared.txt': 'topic\n', 'topic only.txt': 't\n' })
    git(repo, 'switch', '-q', 'main')
    commit(repo, 'main side\n', { 'shared.txt': 'main\n' })
    expect(() => git(repo, 'merge', '-q', '--no-edit', 'topic')).toThrow()

    const sha = commit(repo, 'merge topic into main\n', { 'shared.txt': 'resolved\n' })

    expect(git(repo, 'rev-list', '--parents', '-n', '1', sha).trim().split(' ')).toHaveLength(3)
    expect(buildGitCommitEvent(repo, sha, { env })!.payload.files).toEqual(['shared.txt', 'topic only.txt'])
  })

  it('runs no git option that needs a recent git, for a root, a plain and a merge commit', () => {
    const repo = initRepo('engram')
    commit(repo, 'base\n', { 'shared.txt': 'base\n' })
    git(repo, 'switch', '-q', '-c', 'topic')
    commit(repo, 'topic side\n', { 'topic.txt': 't\n' })
    git(repo, 'switch', '-q', 'main')
    commit(repo, 'main side\n', { 'main.txt': 'm\n' })
    git(repo, 'merge', '-q', '--no-edit', 'topic')
    const calls = join(root, 'git-calls.txt')

    const files = withGitWrapper(calls, false, () =>
      ['HEAD~2', 'HEAD^1', 'HEAD'].map((rev) => buildGitCommitEvent(repo, rev, { env })!.payload.files),
    )

    expect(files).toEqual([['shared.txt'], ['main.txt'], ['topic.txt']])
    const lines = readFileSync(calls, 'utf8').split('\n').filter(Boolean)
    expect(lines.some((l) => l.startsWith('diff-tree'))).toBe(true)
    expect(lines.filter((l) => l.includes('--diff-merges'))).toEqual([])
  })

  it('logs one capture.log line with the exit code when git fails, and gives null', () => {
    const repo = initRepo('engram')
    commit(repo, 'one\n', { 'a.txt': 'a\n' })

    const event = withGitWrapper(join(root, 'git-calls.txt'), true, () => buildGitCommitEvent(repo, 'HEAD', { env }))

    expect(event).toBeNull()
    const log = readFileSync(captureLogPath(env), 'utf8').split('\n').filter(Boolean)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatch(/git diff-tree exited 129$/)
  })

  it('gives a commit made on a detached HEAD a null branch and logs nothing', () => {
    useEmptyRegistry()
    const repo = initRepo('engram')
    commit(repo, 'base\n', { 'a.txt': 'a\n' })
    git(repo, 'checkout', '-q', '--detach')
    const sha = commit(repo, 'detached work\n', { 'b.txt': 'b\n' })

    const event = buildGitCommitEvent(repo, 'HEAD', { env })

    expect(event!.payload.sha).toBe(sha)
    expect(event!.project).toMatchObject({ id: 'engram', branch: null })
    expect(captureLogLines()).toEqual([])
  })

  it('names the main repository from a linked worktree, with the worktree set', () => {
    const repo = initRepo('engram')
    commit(repo, 'init\n')
    const worktree = join(root, 'engram-feature')
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree)
    const sha = commit(worktree, 'feature work\n', { 'f.txt': 'f\n' })

    const event = buildGitCommitEvent(worktree, 'HEAD', { env })

    expect(event!.payload.repo).toBe('engram')
    expect(event!.payload.sha).toBe(sha)
    expect(event!.session_id).toBe('git:engram')
    expect(event!.project).toMatchObject({ id: 'engram', repo_root: worktree, branch: 'feature', worktree: 'engram-feature' })
  })

  it('gives the same event uuid for the same sha read twice', () => {
    const repo = initRepo('engram')
    const sha = commit(repo, 'once\n')
    const a = buildGitCommitEvent(repo, 'HEAD', { env })
    const b = buildGitCommitEvent(repo, sha, { env })
    expect(a!.event_uuid).toBe(b!.event_uuid)
    expect(a!.event_uuid).toBe(eventUuidFromParts('git_commit', 'engram', sha))
  })

  it('reads the parent commit for HEAD~1', () => {
    const repo = initRepo('engram')
    const parent = commit(repo, 'parent\n', { 'p.txt': 'p\n' })
    commit(repo, 'child\n', { 'c.txt': 'c\n' })

    const event = buildGitCommitEvent(repo, 'HEAD~1', { env })

    expect(event!.payload.sha).toBe(parent)
    expect(event!.payload.message).toBe('parent')
    expect(event!.payload.files).toEqual(['p.txt'])
  })

  it('gives an amended commit a new sha and a second event', () => {
    const repo = initRepo('engram')
    commit(repo, 'first\n', { 'a.txt': 'a\n' })
    const before = buildGitCommitEvent(repo, 'HEAD', { env })
    commit(repo, 'first, amended\n', {}, '--amend')
    const after = buildGitCommitEvent(repo, 'HEAD', { env })

    expect(after!.payload.sha).not.toBe(before!.payload.sha)
    expect(after!.event_uuid).not.toBe(before!.event_uuid)
    expect(after!.payload.message).toBe('first, amended')
  })

  it('gives null outside a repository, for an unknown revision, and for an option-shaped revision', () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(buildGitCommitEvent(plain, 'HEAD', { env })).toBeNull()

    const repo = initRepo('engram')
    expect(buildGitCommitEvent(repo, 'HEAD', { env })).toBeNull()
    commit(repo, 'one\n')
    expect(buildGitCommitEvent(repo, 'no-such-branch', { env })).toBeNull()
    expect(buildGitCommitEvent(repo, '--all', { env })).toBeNull()
  })

  it('gives null with no capture.log line for an unknown revision and for a repository with no commits', () => {
    useEmptyRegistry()
    const empty = initRepo('empty')
    expect(buildGitCommitEvent(empty, 'HEAD', { env })).toBeNull()

    const repo = initRepo('engram')
    commit(repo, 'one\n')
    expect(buildGitCommitEvent(repo, 'no-such-branch', { env })).toBeNull()
    expect(buildGitCommitEvent(repo, '0123456789abcdef0123456789abcdef01234567', { env })).toBeNull()

    expect(captureLogLines()).toEqual([])
  })

  it('gives null for a blank message', () => {
    const repo = initRepo('engram')
    git(repo, 'commit', '-q', '--allow-empty', '--allow-empty-message', '--cleanup=verbatim', '-m', '  ')
    expect(buildGitCommitEvent(repo, 'HEAD', { env })).toBeNull()
  })
})

function spooledEvents(): Array<Record<string, unknown>> {
  const dir = spoolRoot(env)
  const walk = (d: string): string[] =>
    existsSync(d)
      ? readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
      : []
  return walk(dir)
    .filter((p) => p.endsWith('.jsonl') && !p.includes('/.dead/'))
    .flatMap((p) => readFileSync(p, 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('runGitCommitCapture', () => {
  it('spools HEAD as one git_commit event and keeps it while no server is configured', async () => {
    const repo = initRepo('engram')
    const sha = commit(repo, 'spooled commit\n\nwith a body\n', { 'a.txt': 'a\n' })

    const result = await runGitCommitCapture(repo, env)

    expect(result).toMatchObject({ events: 1, skipped: null, failures: [] })
    const events = spooledEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      session_id: 'git:engram',
      type: 'git_commit',
      payload: { repo: 'engram', sha, message: 'spooled commit\n\nwith a body', files: ['a.txt'] },
    })
  })

  it('spools nothing outside a repository and still exits cleanly', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)

    const result = await runGitCommitCapture(plain, env)

    expect(result).toMatchObject({ events: 0, skipped: 'no-commit', failures: [] })
    expect(spooledEvents()).toEqual([])
  })
})
