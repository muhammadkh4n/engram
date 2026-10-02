import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPostCommitScript } from '../src/git-setup-cli.js'

const script = buildPostCommitScript('/opt/engram/ingest.js', '/home/u/.engram/env', '/home/u/.engram/git-hook.log')

/** Hooks are disabled so a machine-wide post-commit hook never fires on test commits. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' })
}

/** The lines of the generated hook that compute $REPO, run as a standalone script. */
function repoNameFromHook(cwd: string): string {
  const lines = script.split('\n')
  const start = lines.findIndex((l) => l.startsWith('COMMON_DIR='))
  const end = lines.findIndex((l, i) => i > start && l === 'fi')
  const snippet = [...lines.slice(start, end + 1), 'printf %s "$REPO"'].join('\n')
  return execFileSync('sh', ['-c', snippet], { cwd, encoding: 'utf8' })
}

describe('generated post-commit hook', () => {
  it('lets the ingest CLI detect the project instead of naming the checkout directory', () => {
    const projectArgs = script.match(/--project \S+/g) ?? []
    expect(projectArgs).toEqual(['--project auto', '--project auto'])
    expect(script).not.toContain('--show-toplevel')
  })

  it('takes the repository name for content and session id from the common git dir', () => {
    expect(script).toContain('git rev-parse --path-format=absolute --git-common-dir')
    expect(script).toContain('--session-id "git-$REPO"')
  })

  describe('in a real repository', () => {
    let root: string

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'engram-git-setup-')))
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('names the main repository from inside a linked worktree', () => {
      const main = join(root, 'engram')
      mkdirSync(main)
      git(main, 'init', '-q')
      git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
      const worktree = join(root, 'engram-feature')
      git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree)

      expect(repoNameFromHook(main)).toBe('engram')
      expect(repoNameFromHook(worktree)).toBe('engram')
    })
  })
})
