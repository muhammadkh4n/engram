import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildPostCommitScript } from '../src/git-setup-cli.js'

const script = buildPostCommitScript('/opt/engram/dist/hooks/git-commit.js', '/home/u/.engram/git-hook.log')

/** Hooks are disabled so a machine-wide post-commit hook never fires on test commits. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' })
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8')
      if (text.length > 0) return text
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${path}`)
}

describe('generated post-commit hook', () => {
  it('is valid POSIX sh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-git-setup-sh-'))
    try {
      const path = join(dir, 'post-commit')
      writeFileSync(path, script)
      expect(() => execFileSync('sh', ['-n', path])).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs the commit capture and nothing from the old ingest path', () => {
    expect(script).toContain('command -v engram-capture-commit')
    expect(script).toContain('CAPTURE_FALLBACK="/opt/engram/dist/hooks/git-commit.js"')
    expect(script).toContain('nohup node "$CAPTURE_FALLBACK" >> "/home/u/.engram/git-hook.log"')
    expect(script).not.toContain('engram-ingest')
    expect(script).not.toContain('.engram/env')
    expect(script).not.toContain('--source')
    expect(script).not.toContain('ENGRAM_SALIENCE_DISABLED')
  })

  it('keeps the rebase and cherry-pick skip and the post-commit-local chaining', () => {
    expect(script).toContain('"$GIT_DIR/rebase-merge"')
    expect(script).toContain('"$GIT_DIR/rebase-apply"')
    expect(script).toContain('"$GIT_DIR/CHERRY_PICK_HEAD"')
    expect(script).toContain('LOCAL_HOOK="$GIT_DIR/hooks/post-commit-local"')
  })

  describe('in a real repository', () => {
    let root: string

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'engram-git-setup-')))
    })

    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('starts the capture entry in the commit\'s working directory and chains post-commit-local', async () => {
      const main = join(root, 'engram')
      mkdirSync(main)
      git(main, 'init', '-q')
      git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
      const worktree = join(root, 'engram-feature')
      git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree)

      const ran = join(root, 'capture-ran')
      const entry = join(root, 'git-commit.js')
      writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(ran)}, process.cwd())\n`)
      const chained = join(root, 'local-ran')
      const localHook = join(main, '.git', 'hooks', 'post-commit-local')
      mkdirSync(dirname(localHook), { recursive: true })
      writeFileSync(localHook, `#!/bin/sh\necho chained > ${JSON.stringify(chained)}\n`)
      chmodSync(localHook, 0o755)
      const hook = join(root, 'post-commit')
      writeFileSync(hook, buildPostCommitScript(entry, join(root, 'git-hook.log')))
      chmodSync(hook, 0o755)

      // A PATH without an installed engram-capture-commit, so the fallback entry runs.
      const path = [dirname(process.execPath), '/usr/bin', '/bin'].join(':')
      execFileSync(hook, [], { cwd: worktree, env: { PATH: path, HOME: root } })
      expect(await waitForFile(ran)).toBe(worktree)

      rmSync(ran)
      execFileSync(hook, [], { cwd: main, env: { PATH: path, HOME: root } })
      expect(await waitForFile(ran)).toBe(main)
      expect(readFileSync(chained, 'utf8').trim()).toBe('chained')
    })
  })
})
