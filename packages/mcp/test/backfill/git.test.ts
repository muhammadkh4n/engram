/**
 * The git source against real temporary repositories: which commits it
 * reads, and that each event is the one the post-commit hook builds.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBackfillCli } from '../../src/backfill/engram-backfill-cli.js'
import { buildGitCommitEvent } from '../../src/capture/git-commit-event.js'
import { type CaptureStub, startCaptureStub } from '../capture/stub-server.js'

const TOKEN = 'test-backfill-capture-token'
const OWNER = 'dev@example.com'
const OTHER = 'other@example.com'

// The secret registry is built once per process from process.env, on the
// first scrub, so its source must be in place before any test runs.
const secretsDir = mkdtempSync(join(tmpdir(), 'engram-backfill-git-secrets-'))
const savedEnv = { SOURCES: process.env.ENGRAM_SECRET_SOURCES_FILE, CACHE: process.env.XDG_CACHE_HOME }

beforeAll(() => {
  writeFileSync(join(secretsDir, 'secrets.json'), JSON.stringify({ FIXTURE_SECRET: 'kv8-git-fixture-secret-6630' }))
  writeFileSync(join(secretsDir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
  process.env.ENGRAM_SECRET_SOURCES_FILE = join(secretsDir, 'sources.json')
  process.env.XDG_CACHE_HOME = join(secretsDir, 'cache')
})

afterAll(() => {
  if (savedEnv.SOURCES === undefined) delete process.env.ENGRAM_SECRET_SOURCES_FILE
  else process.env.ENGRAM_SECRET_SOURCES_FILE = savedEnv.SOURCES
  if (savedEnv.CACHE === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = savedEnv.CACHE
  rmSync(secretsDir, { recursive: true, force: true })
})

let home: string
let reposDir: string
let stateDir: string
let tokenFile: string
let registryFile: string
let stub: CaptureStub
let clock: number

/** Hooks and signing are off, so a machine-wide git config never changes what a test commits. */
function git(cwd: string, args: string[], email = OWNER): string {
  clock += 60
  const date = new Date(Date.UTC(2026, 8, 1, 9, 0, 0) + clock * 1000).toISOString()
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: email === OWNER ? 'Dev' : 'Other',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: email === OWNER ? 'Dev' : 'Other',
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  })
}

/** Commits exactly `message` (no cleanup) with one changed file. */
function commit(repo: string, message: string, file: string, email = OWNER): string {
  writeFileSync(join(repo, file), `${message}\n${clock}\n`)
  git(repo, ['add', '--', file], email)
  const msgFile = join(home, 'msg.txt')
  writeFileSync(msgFile, message)
  git(repo, ['commit', '-q', '--cleanup=verbatim', '-F', msgFile], email)
  return git(repo, ['rev-parse', 'HEAD']).trim()
}

function initRepo(name: string): string {
  const dir = join(reposDir, name)
  mkdirSync(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', OWNER])
  return dir
}

beforeEach(async () => {
  clock = 0
  home = realpathSync(mkdtempSync(join(tmpdir(), 'engram-backfill-git-')))
  reposDir = join(home, 'src')
  mkdirSync(reposDir)
  stateDir = join(home, 'backfill-state')
  tokenFile = join(home, 'capture-token')
  writeFileSync(tokenFile, `${TOKEN}\n`)
  registryFile = join(home, 'registry.json')
  writeFileSync(
    registryFile,
    JSON.stringify({
      version: 1,
      workspaces: { acme: { root: reposDir, vault_folder: null, register_prefix: null } },
      projects: { 'acme-web': { workspace: 'acme', vault_folder: null, register_prefix: null } },
    }),
  )
  stub = await startCaptureStub()
})

afterEach(async () => {
  await stub.close()
  rmSync(home, { recursive: true, force: true })
})

async function backfill(...extra: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const argv = ['git', '--target', stub.url, '--token-file', tokenFile, '--registry', registryFile, '--state-dir', stateDir, '--json', ...extra]
  const code = await runBackfillCli(argv, { HOME: home }, { out: (t) => (out += t), err: (t) => (err += t) })
  return { code, out, err }
}

function sentEvents(): Array<Record<string, unknown>> {
  return stub.received.flatMap((r) => r.body.events)
}

/** A history with another author's commit, a merge commit and a squash commit. */
function buildHistory(repo: string): { expected: string[]; merge: string; foreign: string } {
  const first = commit(repo, 'feat: add the login form\n\nKeeps both fields.  ', 'login.txt')
  const foreign = commit(repo, 'docs: describe the form', 'README.md', OTHER)
  git(repo, ['checkout', '-q', '-b', 'topic'])
  const topic = commit(repo, 'fix: trim the user name', 'trim.txt')
  git(repo, ['checkout', '-q', 'main'])
  commit(repo, 'chore: bump the version', 'version.txt')
  git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge branch topic', 'topic'])
  const merge = git(repo, ['rev-parse', 'HEAD']).trim()
  git(repo, ['checkout', '-q', '-b', 'squashed'])
  commit(repo, 'wip one', 'a.txt')
  commit(repo, 'wip two', 'b.txt')
  git(repo, ['checkout', '-q', 'main'])
  git(repo, ['merge', '-q', '--squash', 'squashed'])
  git(repo, ['commit', '-q', '-m', 'feat: the export menu (TST-8)'])
  const squash = git(repo, ['rev-parse', 'HEAD']).trim()
  const bump = git(repo, ['log', '-1', '--format=%H', '--grep=bump']).trim()
  return { expected: [first, topic, bump, squash], merge, foreign }
}

describe('engram-backfill git', () => {
  it("sends the configured author's non-merge commits, each as the hook builds it", async () => {
    const repo = initRepo('acme-web')
    const { expected, merge, foreign } = buildHistory(repo)

    const run = await backfill('--repo', repo, '--apply')
    const summary = JSON.parse(run.out)
    const events = sentEvents()
    const shas = events.map((e) => (e.payload as { sha: string }).sha)

    expect(run.code).toBe(0)
    expect(new Set(shas)).toEqual(new Set(expected))
    expect(shas).toHaveLength(expected.length)
    expect(shas).not.toContain(merge)
    expect(shas).not.toContain(foreign)
    const hookEnv = { HOME: home, ENGRAM_PROJECT_REGISTRY_FILE: registryFile }
    for (const event of events) {
      const built = buildGitCommitEvent(repo, (event.payload as { sha: string }).sha, { env: hookEnv })
      expect(event).toEqual(JSON.parse(JSON.stringify(built)))
    }
    expect((events[0]!.payload as { message: string }).message).toBe('feat: add the login form\n\nKeeps both fields.  ')
    expect(summary.repos).toEqual([
      { path: repo, repo: 'acme-web', branch: 'main', ref: 'refs/heads/main', authors: [OWNER], commits: 4 },
    ])
    expect(summary).toMatchObject({ accepted: 4, duplicates: 0, events: { git_commit: 4 }, stopped: null })
    expect(stub.received.every((r) => r.body.client.name === 'engram-backfill')).toBe(true)
  })

  it('reads the branch origin/HEAD names, without fetching', async () => {
    const repo = initRepo('acme-web')
    const kept = commit(repo, 'feat: on the default branch', 'one.txt')
    git(repo, ['update-ref', 'refs/remotes/origin/develop', kept])
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'])
    commit(repo, 'feat: only on the local main', 'two.txt')

    const run = await backfill('--repo', repo, '--apply')
    const summary = JSON.parse(run.out)

    expect(sentEvents().map((e) => (e.payload as { sha: string }).sha)).toEqual([kept])
    expect(summary.repos[0]).toMatchObject({ branch: 'develop', ref: 'refs/remotes/origin/develop', commits: 1 })
  })

  it('lists main clones under a directory and skips a repository the registry does not hold', async () => {
    const web = initRepo('acme-web')
    commit(web, 'feat: the web app', 'web.txt')
    git(web, ['worktree', 'add', '-q', join(reposDir, 'acme-web-fix-login')])
    const docs = initRepo('acme-docs')
    commit(docs, 'docs: the guide', 'guide.txt')
    mkdirSync(join(reposDir, 'notes'))

    const run = await backfill('--repos-under', reposDir, '--author-email', OWNER, '--apply')
    const summary = JSON.parse(run.out)

    expect(summary.repos.map((r: { repo: string }) => r.repo)).toEqual(['acme-web'])
    expect(summary.skipped).toEqual([{ path: docs, repo: 'acme-docs', reason: 'unregistered' }])
    expect(new Set(sentEvents().map((e) => e.session_id))).toEqual(new Set(['git:acme-web']))
  })

  it('exits 2 without a repository to read or with another command\'s flag', async () => {
    let err = ''
    const io = { out: () => {}, err: (t: string) => (err += t) }

    expect(await runBackfillCli(['git', '--json'], {}, io)).toBe(2)
    expect(await runBackfillCli(['git', '--repo', reposDir, '--history-file', 'h.jsonl'], {}, io)).toBe(2)
    expect(await runBackfillCli(['git', '--repo', reposDir, '--since', 'last week'], {}, io)).toBe(2)
    expect(err).toContain('git needs --repo or --repos-under')
    expect(err).toContain('git does not take --history-file')
    expect(err).toContain('--since must be an ISO date')
  })

  it('reports only duplicates on a second run and sends nothing on a dry run', async () => {
    const repo = initRepo('acme-web')
    buildHistory(repo)

    const dry = await backfill('--repo', repo)
    expect(stub.received).toHaveLength(0)
    expect(JSON.parse(dry.out)).toMatchObject({ apply: false, events: { git_commit: 4 }, accepted: 0 })

    stub.reply = (() => {
      const seen = new Set<string>()
      return (request) => {
        let accepted = 0
        let duplicates = 0
        for (const event of request.body.events) {
          const key = String(event.event_uuid)
          if (seen.has(key)) duplicates++
          else {
            seen.add(key)
            accepted++
          }
        }
        return { status: 200, body: { accepted, duplicates, rejected: [] } }
      }
    })()
    await backfill('--repo', repo, '--apply')
    const second = await backfill('--repo', repo, '--apply')

    expect(JSON.parse(second.out)).toMatchObject({ accepted: 0, duplicates: 4, stopped: null })
  })
})
