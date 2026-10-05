/**
 * Tests for project identity resolution.
 *
 * resolveProjectScope is the single source of truth for the hard `project_id`
 * column used by both ingest (tag) and recall (filter) — if they disagree,
 * scoped recall silently returns nothing, so the precedence and the
 * shared-alias → NULL mapping are correctness-critical.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  detectCheckout,
  detectProject,
  resolveProject,
  resolveProjectScope,
  formatScopeLog,
  normalizeProjectId,
  projectForCategory,
} from '../src/ingest/project-detect.js'
import { resetProjectRootsWarning } from '../src/ingest/project-roots.js'

/** Hooks are disabled so a machine-wide post-commit hook never fires on test commits. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' })
}

function initRepoWithCommit(dir: string): void {
  git(dir, 'init', '-q')
  git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
}

describe('detectProject', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'engram-detect-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns the basename of the nearest .git ancestor', () => {
    const repo = join(root, 'my-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const deep = join(repo, 'packages', 'core', 'src')
    mkdirSync(deep, { recursive: true })

    // From a deep monorepo subpackage, the first git ancestor wins.
    expect(detectProject(deep)).toBe('my-repo')
    expect(detectProject(repo)).toBe('my-repo')
  })

  it('coarsens monorepo subpackages to one project (first git ancestor)', () => {
    const repo = join(root, 'engram')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const pkgA = join(repo, 'packages', 'graph')
    const pkgB = join(repo, 'packages', 'core')
    mkdirSync(pkgA, { recursive: true })
    mkdirSync(pkgB, { recursive: true })

    expect(detectProject(pkgA)).toBe('engram')
    expect(detectProject(pkgB)).toBe('engram')
  })

  it('returns null (shared) when no .git ancestor exists, never the directory name', () => {
    const plain = join(root, 'just-a-folder')
    mkdirSync(plain, { recursive: true })
    expect(detectProject(plain)).toBeNull()
  })

  it('treats a home directory, its .claude dir and the temp dir as shared', () => {
    const home = join(root, 'home', 'someone')
    const dotClaude = join(home, '.claude')
    const githubOrg = join(home, 'projects', 'github', 'someone')
    mkdirSync(dotClaude, { recursive: true })
    mkdirSync(githubOrg, { recursive: true })
    expect(detectProject(home)).toBeNull()
    expect(detectProject(dotClaude)).toBeNull()
    expect(detectProject(githubOrg)).toBeNull()
    expect(detectProject(tmpdir())).toBeNull()
  })

  it('resolves a linked worktree to the main repository name (absolute gitdir)', () => {
    const main = join(root, 'engram')
    const adminDir = join(main, '.git', 'worktrees', 'engram-feature')
    mkdirSync(adminDir, { recursive: true })
    writeFileSync(join(adminDir, 'commondir'), '../..\n')
    const worktree = join(root, 'engram-feature')
    mkdirSync(join(worktree, 'packages', 'core'), { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${adminDir}\n`)

    expect(detectProject(worktree)).toBe('engram')
    expect(detectProject(join(worktree, 'packages', 'core'))).toBe('engram')
  })

  it('resolves a linked worktree whose gitdir is relative', () => {
    const main = join(root, 'repos', 'sam-mfe')
    const adminDir = join(main, '.git', 'worktrees', 'wt')
    mkdirSync(adminDir, { recursive: true })
    writeFileSync(join(adminDir, 'commondir'), '../..')
    const worktree = join(root, 'repos', 'sam-mfe-fix-grid')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, '.git'), 'gitdir: ../sam-mfe/.git/worktrees/wt\n')

    expect(detectProject(worktree)).toBe('sam-mfe')
  })

  it('resolves a worktree of a bare repository to the repository name without .git', () => {
    const bare = join(root, 'dotfiles.git')
    const adminDir = join(bare, 'worktrees', 'main')
    mkdirSync(adminDir, { recursive: true })
    writeFileSync(join(adminDir, 'commondir'), '../..')
    const worktree = join(root, 'dotfiles-main')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${adminDir}`)

    expect(detectProject(worktree)).toBe('dotfiles')
  })

  it('resolves a worktree made by git worktree add to the main repository name', () => {
    const main = join(root, 'real-repo')
    mkdirSync(main, { recursive: true })
    initRepoWithCommit(main)
    const worktree = join(root, 'real-repo-feature')
    git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree)

    expect(detectProject(worktree)).toBe('real-repo')
  })

  it('keeps a submodule under its own name', () => {
    const superRepo = join(root, 'super')
    mkdirSync(join(superRepo, '.git', 'modules', 'vendor-lib'), { recursive: true })
    const sub = join(superRepo, 'libs', 'vendor-lib')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/vendor-lib\n')

    expect(detectProject(sub)).toBe('vendor-lib')
  })

  it('falls back to the containing directory when the .git file is unreadable or malformed', () => {
    const repo = join(root, 'odd-repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, '.git'), 'not a gitdir pointer')
    expect(detectProject(repo)).toBe('odd-repo')
  })
})

describe('detectCheckout', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'engram-checkout-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('names a main checkout with its own root and no worktree', () => {
    const repo = join(root, 'plain-repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true })

    expect(detectCheckout(join(repo, 'src', 'deep'))).toEqual({ repo: 'plain-repo', repoRoot: repo, worktree: null })
  })

  it('names a linked worktree by its main repository, its own root and its directory name', () => {
    const main = join(root, 'real-repo')
    mkdirSync(main, { recursive: true })
    initRepoWithCommit(main)
    const worktree = join(root, 'real-repo-topic')
    git(main, 'worktree', 'add', '-q', '-b', 'topic', worktree)
    mkdirSync(join(worktree, 'pkg'), { recursive: true })

    expect(detectCheckout(join(worktree, 'pkg'))).toEqual({ repo: 'real-repo', repoRoot: worktree, worktree: 'real-repo-topic' })
  })

  it('treats a submodule as its own checkout, not a worktree', () => {
    const superRepo = join(root, 'super')
    mkdirSync(join(superRepo, '.git', 'modules', 'vendor-lib'), { recursive: true })
    const sub = join(superRepo, 'libs', 'vendor-lib')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/vendor-lib\n')

    expect(detectCheckout(sub)).toEqual({ repo: 'vendor-lib', repoRoot: sub, worktree: null })
  })

  it('returns null outside any repository', () => {
    const loose = join(root, 'loose', 'dir')
    mkdirSync(loose, { recursive: true })
    expect(detectCheckout(loose)).toBeNull()
  })
})

describe('resolveProject (--project flag)', () => {
  it('maps none and the other shared aliases to null (shared)', () => {
    for (const flag of ['none', 'global', 'shared', 'None']) {
      expect(resolveProject(flag, '/tmp', {})).toBeNull()
    }
  })

  it('keeps an explicit project name verbatim', () => {
    expect(resolveProject('my-named-project', '/tmp', {})).toBe('my-named-project')
  })

  it('auto resolves through the same rules as the hard scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'engram-auto-'))
    try {
      const repo = join(root, 'widget-svc')
      mkdirSync(join(repo, '.git'), { recursive: true })
      expect(resolveProject('auto', repo, {})).toBe('widget-svc')
      expect(resolveProject('auto', root, {})).toBeNull()
      expect(resolveProject('auto', repo, { ENGRAM_PROJECT_ID: 'pinned' })).toBe('pinned')
      expect(resolveProject('auto', repo, { ENGRAM_PROJECT_ID: 'shared' })).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('projectForCategory', () => {
  it('stores preferences, identities and emotional signals shared', () => {
    for (const category of ['preference', 'identity', 'emotional_signal'] as const) {
      expect(projectForCategory('engram', category)).toBeNull()
    }
  })

  it('keeps the project for project-bound categories', () => {
    for (const category of ['fact', 'decision', 'lesson', 'milestone', 'plan', 'risk'] as const) {
      expect(projectForCategory('engram', category)).toBe('engram')
    }
  })

  it('stays shared when there is no project', () => {
    expect(projectForCategory(null, 'decision')).toBeNull()
  })
})

describe('normalizeProjectId', () => {
  it('trims a project name', () => {
    expect(normalizeProjectId('  engram ')).toBe('engram')
  })

  it('maps blank, shared aliases and non-strings to undefined (shared)', () => {
    for (const raw of ['', '   ', 'global', 'None', 'SHARED', undefined, null, 42]) {
      expect(normalizeProjectId(raw)).toBeUndefined()
    }
  })
})

describe('resolveProjectScope (hard project_id)', () => {
  it('prefers ENGRAM_PROJECT_ID over detected cwd', () => {
    const repo = mkdtempSync(join(tmpdir(), 'engram-scope-'))
    mkdirSync(join(repo, '.git'), { recursive: true })
    try {
      const scope = resolveProjectScope({
        env: { ENGRAM_PROJECT_ID: 'explicit-project' },
        cwd: repo,
      })
      expect(scope).toEqual({ id: 'explicit-project', source: 'env' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('maps shared aliases to NULL (shared bucket) via env', () => {
    for (const alias of ['global', 'none', 'shared', 'GLOBAL', 'None']) {
      const scope = resolveProjectScope({ env: { ENGRAM_PROJECT_ID: alias }, cwd: '/tmp' })
      expect(scope.id).toBeNull()
      expect(scope.source).toBe('env')
    }
  })

  it('trims whitespace and treats blank env as unset', () => {
    const plain = mkdtempSync(join(tmpdir(), 'engram-blank-'))
    try {
      // Blank/whitespace env → falls through to detection.
      const scope = resolveProjectScope({ env: { ENGRAM_PROJECT_ID: '   ' }, cwd: plain })
      expect(scope.source).not.toBe('env')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('falls back to detectProject basename when env unset', () => {
    const repo = mkdtempSync(join(tmpdir(), 'engram-detect2-'))
    const named = join(repo, 'widget-svc')
    mkdirSync(join(named, '.git'), { recursive: true })
    try {
      const scope = resolveProjectScope({ env: {}, cwd: named })
      expect(scope).toEqual({ id: 'widget-svc', source: 'detected' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('returns unscoped NULL outside any repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'engram-norepo-'))
    try {
      expect(resolveProjectScope({ env: {}, cwd: plain })).toEqual({ id: null, source: 'unscoped' })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('returns unscoped NULL when detection yields a shared alias', () => {
    // A cwd whose basename is literally "global" must not become an isolating id.
    const repo = mkdtempSync(join(tmpdir(), 'engram-glob-'))
    const globalDir = join(repo, 'global')
    mkdirSync(join(globalDir, '.git'), { recursive: true })
    try {
      const scope = resolveProjectScope({ env: {}, cwd: globalDir })
      expect(scope.id).toBeNull()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('resolveProjectScope (configured roots)', () => {
  let base: string
  let groupsFile: string

  function writeRoots(doc: unknown): void {
    writeFileSync(groupsFile, typeof doc === 'string' ? doc : JSON.stringify(doc))
  }
  function scopeAt(cwd: string) {
    return resolveProjectScope({ env: { ENGRAM_PROJECT_GROUPS_FILE: groupsFile }, cwd })
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'engram-roots-'))
    groupsFile = join(base, 'project-groups.json')
    resetProjectRootsWarning()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(base, { recursive: true, force: true })
  })

  it('names the project from a root when no git ancestor exists', () => {
    const workspace = join(base, 'workspace')
    const deep = join(workspace, 'notes', 'scratch')
    mkdirSync(deep, { recursive: true })
    writeRoots({ groups: { acme: ['acme-*'] }, roots: { [workspace]: 'acme' } })

    expect(scopeAt(workspace)).toEqual({ id: 'acme', source: 'root' })
    expect(scopeAt(deep)).toEqual({ id: 'acme', source: 'root' })
  })

  it('lets a git repository win over an enclosing root', () => {
    const workspace = join(base, 'workspace')
    const repo = join(workspace, 'acme-api')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeRoots({ roots: { [workspace]: 'acme' } })

    expect(scopeAt(join(repo))).toEqual({ id: 'acme-api', source: 'detected' })
  })

  it('picks the longest matching root', () => {
    const outer = join(base, 'org')
    const inner = join(outer, 'team')
    const cwd = join(inner, 'docs')
    mkdirSync(cwd, { recursive: true })
    writeRoots({ roots: { [outer]: 'org-wide', [inner]: 'team-project' } })

    expect(scopeAt(cwd)).toEqual({ id: 'team-project', source: 'root' })
    expect(scopeAt(join(outer))).toEqual({ id: 'org-wide', source: 'root' })
  })

  it('matches on path-segment boundaries only', () => {
    const root = join(base, 'ab')
    const sibling = join(base, 'abc')
    mkdirSync(root, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeRoots({ roots: { [root]: 'ab-project' } })

    expect(scopeAt(sibling)).toEqual({ id: null, source: 'unscoped' })
  })

  it('normalises root keys with path.resolve', () => {
    const workspace = join(base, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeRoots({ roots: { [`${workspace}/./`]: 'acme' } })

    expect(scopeAt(workspace)).toEqual({ id: 'acme', source: 'root' })
  })

  it('falls back to null without throwing on a malformed file, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cwd = join(base, 'workspace')
    mkdirSync(cwd, { recursive: true })
    writeRoots('{ "roots": { not json')

    expect(scopeAt(cwd)).toEqual({ id: null, source: 'unscoped' })
    expect(scopeAt(cwd)).toEqual({ id: null, source: 'unscoped' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('skips non-string values and a non-object roots key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const workspace = join(base, 'workspace')
    const other = join(base, 'other')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(other, { recursive: true })
    writeRoots({ roots: { [workspace]: 42, [other]: 'other-project', relative: 'x' } })

    expect(scopeAt(workspace)).toEqual({ id: null, source: 'unscoped' })
    expect(scopeAt(other)).toEqual({ id: 'other-project', source: 'root' })

    writeRoots({ roots: ['not', 'an', 'object'] })
    expect(scopeAt(other)).toEqual({ id: null, source: 'unscoped' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('ignores roots when the groups file is unset', () => {
    const plain = join(base, 'workspace')
    mkdirSync(plain, { recursive: true })
    expect(resolveProjectScope({ env: {}, cwd: plain })).toEqual({ id: null, source: 'unscoped' })
  })
})

describe('formatScopeLog', () => {
  it('describes a scoped id with its source', () => {
    expect(formatScopeLog({ id: 'engram', source: 'env' })).toBe(
      'project scope: engram (source: ENGRAM_PROJECT_ID)',
    )
    expect(formatScopeLog({ id: 'engram', source: 'detected' })).toBe(
      'project scope: engram (source: detected from cwd)',
    )
    expect(formatScopeLog({ id: 'acme', source: 'root' })).toBe(
      'project scope: acme (source: configured root)',
    )
  })

  it('describes the shared bucket and hints at the override', () => {
    const msg = formatScopeLog({ id: null, source: 'unscoped' })
    expect(msg).toContain('shared')
    expect(msg).toContain('ENGRAM_PROJECT_ID')
  })
})
