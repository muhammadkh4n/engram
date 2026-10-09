import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCaptureRegistry, resolveEventProject } from '../../src/capture/event-project.js'
import { captureLogPath } from '../../src/capture/log.js'

/** Hooks are disabled so a machine-wide post-commit hook never fires on test commits. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' })
}

let home: string
let env: Record<string, string>

function writeRegistry(doc: unknown): void {
  writeFileSync(join(home, 'registry.json'), JSON.stringify(doc))
}

const REGISTRY = {
  version: 1,
  workspaces: { 'tst-ws': { root: '~/ws', vault_folder: 'Tst', register_prefix: null } },
  projects: {
    'listed-repo': { workspace: 'tst-ws', vault_folder: null, register_prefix: null },
    'loose-repo': { workspace: null, vault_folder: null, register_prefix: null },
  },
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'engram-event-project-'))
  env = { HOME: home, ENGRAM_PROJECT_REGISTRY_FILE: '~/registry.json' }
  writeRegistry(REGISTRY)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function logLines(): string[] {
  const path = captureLogPath(env)
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
}

describe('resolveEventProject', () => {
  it('names a linked worktree by its main repository, with the worktree directory and root', () => {
    const main = join(home, 'code', 'sample-main')
    mkdirSync(main, { recursive: true })
    git(main, 'init', '-q')
    git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
    const worktree = join(home, 'code', 'sample-main-topic')
    git(main, 'worktree', 'add', '-q', '-b', 'topic', worktree)
    mkdirSync(join(worktree, 'src'))

    expect(resolveEventProject(join(worktree, 'src'), 'topic', loadCaptureRegistry(env))).toEqual({
      id: 'sample-main',
      workspace: null,
      repo_root: worktree,
      branch: 'topic',
      worktree: 'sample-main-topic',
    })
  })

  it('gives a workspace root no project id, only its workspace', () => {
    const dir = join(home, 'ws', 'notes')
    mkdirSync(dir, { recursive: true })
    const registry = loadCaptureRegistry(env)

    expect(resolveEventProject(join(home, 'ws'), 'main', registry)).toEqual({
      id: null,
      workspace: 'tst-ws',
      repo_root: null,
      branch: null,
      worktree: null,
    })
    expect(resolveEventProject(dir, 'main', registry)).toMatchObject({ id: null, workspace: 'tst-ws' })
  })

  it('takes a listed repository workspace from the registry, wherever it is checked out', () => {
    const repo = join(home, 'elsewhere', 'listed-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })

    expect(resolveEventProject(repo, 'main', loadCaptureRegistry(env))).toEqual({
      id: 'listed-repo',
      workspace: 'tst-ws',
      repo_root: repo,
      branch: 'main',
      worktree: null,
    })
  })

  it('keeps a listed workspace of null even when a workspace root contains the repository', () => {
    const repo = join(home, 'ws', 'loose-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })

    expect(resolveEventProject(repo, '', loadCaptureRegistry(env))).toMatchObject({ id: 'loose-repo', workspace: null, branch: null })
  })

  it('gives an unlisted repository under a workspace root that workspace', () => {
    const repo = join(home, 'ws', 'other-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })

    expect(resolveEventProject(repo, 'main', loadCaptureRegistry(env))).toMatchObject({ id: 'other-repo', workspace: 'tst-ws' })
  })

  it('gives an unknown directory nothing', () => {
    const dir = join(home, 'scratch')
    mkdirSync(dir)

    expect(resolveEventProject(dir, 'main', loadCaptureRegistry(env))).toEqual({
      id: null,
      workspace: null,
      repo_root: null,
      branch: null,
      worktree: null,
    })
    expect(resolveEventProject(null, 'main', loadCaptureRegistry(env))).toMatchObject({ id: null, workspace: null })
  })
})

describe('loadCaptureRegistry', () => {
  it('expands ~/ in workspace roots against the env HOME', () => {
    expect(loadCaptureRegistry(env).workspaces.get('tst-ws')?.root).toBe(join(home, 'ws'))
  })

  it('gives a missing registry file an empty registry and one capture-log line, without throwing', () => {
    rmSync(join(home, 'registry.json'))
    const dir = join(home, 'ws')
    mkdirSync(dir)

    const registry = loadCaptureRegistry(env)

    expect(registry.workspaces.size).toBe(0)
    expect(registry.projects.size).toBe(0)
    expect(resolveEventProject(dir, 'main', registry)).toMatchObject({ id: null, workspace: null })
    const lines = logLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('project registry unreadable (ENOENT)')
  })

  it('logs an invalid registry by key path and rule and returns an empty registry', () => {
    writeRegistry({ ...REGISTRY, version: 2 })
    expect(loadCaptureRegistry(env).workspaces.size).toBe(0)
    writeFileSync(join(home, 'registry.json'), '{not json')
    expect(loadCaptureRegistry(env).projects.size).toBe(0)

    const lines = logLines()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('version: must be 1')
    expect(lines[1]).toContain('not valid JSON')
  })

  it('gives an unset variable an empty registry and one capture-log line naming the variable', () => {
    delete env.ENGRAM_PROJECT_REGISTRY_FILE
    expect(loadCaptureRegistry(env).workspaces.size).toBe(0)
    const lines = logLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('project registry not configured (ENGRAM_PROJECT_REGISTRY_FILE unset)')
  })

  it('writes the unset-variable line once per process and again only after the condition changed', () => {
    delete env.ENGRAM_PROJECT_REGISTRY_FILE
    loadCaptureRegistry(env)
    loadCaptureRegistry(env)
    expect(logLines()).toHaveLength(1)

    env.ENGRAM_PROJECT_REGISTRY_FILE = '~/registry.json'
    expect(loadCaptureRegistry(env).projects.size).toBe(2)
    delete env.ENGRAM_PROJECT_REGISTRY_FILE
    loadCaptureRegistry(env)

    const lines = logLines()
    expect(lines).toHaveLength(2)
    expect(lines.every((l) => l.includes('project registry not configured'))).toBe(true)
  })
})
