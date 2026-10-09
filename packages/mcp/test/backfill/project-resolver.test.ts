import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProjectResolver,
  loadOverrides,
  loadResolverRegistry,
  type ProjectResolver,
} from '../../src/backfill/project-resolver.js'

const REGISTRY = {
  version: 1,
  workspaces: { acme: { root: '/home/u/work/acme', vault_folder: null, register_prefix: null } },
  projects: { 'acme-web': { workspace: 'acme', vault_folder: null, register_prefix: null } },
}

let dir: string
let resolve: ProjectResolver

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-backfill-resolver-'))
  writeFileSync(join(dir, 'registry.json'), JSON.stringify(REGISTRY))
  writeFileSync(join(dir, 'overrides.json'), JSON.stringify({ 'web-old': 'acme-web', scratch: null }))
  const env = { HOME: '/home/u' }
  const registry = loadResolverRegistry(join(dir, 'registry.json'), env)
  resolve = createProjectResolver({ registry, overrides: loadOverrides(join(dir, 'overrides.json'), env) }, env)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('project resolver: names', () => {
  it('resolves a registered repository by its exact name', () => {
    expect(resolve('acme-web')).toEqual({ project_id: 'acme-web', workspace_id: 'acme', rule: 'repository', raw: 'acme-web' })
  })

  it('folds a worktree name into its repository', () => {
    expect(resolve('acme-web-fix-login')).toMatchObject({ project_id: 'acme-web', workspace_id: 'acme', rule: 'worktree' })
  })

  it('resolves a workspace id to the workspace with no project', () => {
    expect(resolve('acme')).toMatchObject({ project_id: null, workspace_id: 'acme', rule: 'workspace' })
  })

  it('gives null for a dot-folder', () => {
    expect(resolve('.claude')).toMatchObject({ project_id: null, workspace_id: null, rule: 'no-repo' })
  })

  it('gives null with rule unregistered for a name the registry does not know', () => {
    expect(resolve('notes')).toEqual({ project_id: null, workspace_id: null, rule: 'unregistered', raw: 'notes' })
  })

  it('applies an override before any other rule', () => {
    expect(resolve('web-old')).toMatchObject({ project_id: 'acme-web', workspace_id: 'acme', rule: 'override' })
    expect(resolve('scratch')).toMatchObject({ project_id: null, workspace_id: null, rule: 'override' })
  })
})

describe('project resolver: paths', () => {
  it('resolves a workspace root to its workspace', () => {
    expect(resolve('/home/u/work/acme')).toMatchObject({ project_id: null, workspace_id: 'acme', rule: 'workspace' })
  })

  it('resolves the first segment below a root as a name, even when the path is gone', () => {
    expect(resolve('/home/u/work/acme/acme-web-fix-login/src')).toMatchObject({
      project_id: 'acme-web',
      workspace_id: 'acme',
      rule: 'worktree',
      raw: '/home/u/work/acme/acme-web-fix-login/src',
    })
  })

  it('keeps the workspace when the first segment below a root names no project', () => {
    expect(resolve('/home/u/work/acme/notes/drafts')).toMatchObject({ project_id: null, workspace_id: 'acme', rule: 'workspace' })
  })

  it('resolves a path inside .claude/worktrees as the checkout that holds it', () => {
    expect(resolve('/home/u/src/acme-web/.claude/worktrees/agent-1')).toMatchObject({
      project_id: 'acme-web',
      workspace_id: 'acme',
      rule: 'repository',
    })
  })

  it('takes the deepest resolving segment outside any root', () => {
    expect(resolve('/home/u/src/acme-web/packages/notes')).toMatchObject({ project_id: 'acme-web', rule: 'repository' })
  })

  it('expands ~ against HOME', () => {
    expect(resolve('~/work/acme')).toMatchObject({ project_id: null, workspace_id: 'acme', rule: 'workspace' })
  })

  it('gives null when no segment resolves', () => {
    expect(resolve('/home/u/scratch-area/tmp')).toMatchObject({ project_id: null, workspace_id: null, rule: 'unregistered' })
  })
})

describe('project resolver: files', () => {
  it('refuses an override that maps to neither a name nor null', () => {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ 'web-old': 7 }))
    expect(() => loadOverrides(join(dir, 'bad.json'), {})).toThrow(/"web-old" must map to a project name or null/)
  })

  it('refuses a registry file that does not parse', () => {
    writeFileSync(join(dir, 'broken.json'), '{')
    expect(() => loadResolverRegistry(join(dir, 'broken.json'), {})).toThrow(/not valid JSON/)
  })
})
