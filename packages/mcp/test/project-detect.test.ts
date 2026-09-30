/**
 * Tests for project identity resolution.
 *
 * resolveProjectScope is the single source of truth for the hard `project_id`
 * column used by both ingest (tag) and recall (filter) — if they disagree,
 * scoped recall silently returns nothing, so the precedence and the
 * shared-alias → NULL mapping are correctness-critical.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectProject,
  resolveProject,
  resolveProjectScope,
  formatScopeLog,
  normalizeProjectId,
  projectForCategory,
} from '../src/ingest/project-detect.js'

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

describe('formatScopeLog', () => {
  it('describes a scoped id with its source', () => {
    expect(formatScopeLog({ id: 'engram', source: 'env' })).toBe(
      'project scope: engram (source: ENGRAM_PROJECT_ID)',
    )
    expect(formatScopeLog({ id: 'engram', source: 'detected' })).toBe(
      'project scope: engram (source: detected from cwd)',
    )
  })

  it('describes the shared bucket and hints at the override', () => {
    const msg = formatScopeLog({ id: null, source: 'unscoped' })
    expect(msg).toContain('shared')
    expect(msg).toContain('ENGRAM_PROJECT_ID')
  })
})
