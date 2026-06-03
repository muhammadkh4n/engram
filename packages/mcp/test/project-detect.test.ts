/**
 * Tests for project identity resolution.
 *
 * resolveProjectScope is the single source of truth for the hard `project_id`
 * column used by both ingest (tag) and recall (filter) — if they disagree,
 * scoped recall silently returns nothing, so the precedence and the
 * shared-alias → NULL mapping are correctness-critical.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectProject,
  resolveProject,
  resolveProjectScope,
  formatScopeLog,
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

  it('falls back to cwd basename when no .git ancestor exists', () => {
    const plain = join(root, 'just-a-folder')
    mkdirSync(plain, { recursive: true })
    expect(detectProject(plain)).toBe('just-a-folder')
  })
})

describe('resolveProject (soft tag — legacy)', () => {
  it('maps none → global, auto → detected, explicit → verbatim', () => {
    expect(resolveProject('none', '/tmp')).toBe('global')
    expect(resolveProject('my-named-project', '/tmp')).toBe('my-named-project')
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
      // Blank/whitespace env → falls through to detection (cwd basename).
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

  it('returns unscoped NULL when detection yields a shared alias', () => {
    // A cwd whose basename is literally "global" must not become an isolating id.
    const repo = mkdtempSync(join(tmpdir(), 'engram-glob-'))
    const globalDir = join(repo, 'global')
    mkdirSync(globalDir, { recursive: true })
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
