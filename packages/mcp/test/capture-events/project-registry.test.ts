/**
 * The project registry: the file shape parses exactly and every refusal names
 * its path; event scope resolves against it (registered project over the sent
 * workspace, unregistered ids reported, register entries matched by scope and
 * id prefix); the rows sync into memory_projects with a retry until the first
 * success.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRow } from '@engram-mem/core'
import type { CaptureEvent } from '../../src/capture-events/contract.js'
import {
  PROJECT_SYNC_RETRY_MS,
  loadProjectRegistry,
  parseProjectRegistry,
  registryRows,
  resolveEventScope,
  startProjectSync,
} from '../../src/capture-events/project-registry.js'
import { validEvent, type FixtureEvent } from './fixtures.js'

function sampleDoc(): Record<string, any> {
  return {
    version: 1,
    workspaces: {
      'ws-test': { root: '~/work/ws-test', vault_folder: 'Sample Workspace', register_prefix: 'TSTW' },
      'ws-other': { root: '/srv/ws-other', vault_folder: null, register_prefix: null },
    },
    projects: {
      'sample-repo': { workspace: 'ws-test', vault_folder: 'Sample Repo', register_prefix: 'TST' },
      'loose-repo': { workspace: null, vault_folder: null, register_prefix: null },
    },
  }
}

function refusal(doc: unknown): string {
  try {
    parseProjectRegistry(doc)
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('the registry was accepted')
}

function asEvent(fixture: FixtureEvent): CaptureEvent {
  return fixture as unknown as CaptureEvent
}

function withProject(project: Record<string, unknown>): CaptureEvent {
  const event = validEvent('user_prompt')
  return asEvent({ ...event, project: { ...(event.project as object), ...project } })
}

function registerEntry(id: string, scope: string): CaptureEvent {
  const event = validEvent('register_entry')
  return asEvent({ ...event, payload: { ...event.payload, id, scope } })
}

describe('parseProjectRegistry', () => {
  it('parses the registry shape into workspaces and projects', () => {
    const registry = parseProjectRegistry(sampleDoc())
    expect(registry.version).toBe(1)
    expect(registry.workspaces.get('ws-test')).toEqual({
      id: 'ws-test',
      root: '~/work/ws-test',
      vaultFolder: 'Sample Workspace',
      registerPrefix: 'TSTW',
    })
    expect(registry.projects.get('sample-repo')).toEqual({
      id: 'sample-repo',
      workspace: 'ws-test',
      vaultFolder: 'Sample Repo',
      registerPrefix: 'TST',
    })
    expect(registry.projects.get('loose-repo')?.workspace).toBeNull()
  })

  it('refuses version 2', () => {
    expect(refusal({ ...sampleDoc(), version: 2 })).toBe('project registry: version: must be 1')
  })

  it('refuses an unknown key at every level, naming its path', () => {
    expect(refusal({ ...sampleDoc(), extra: true })).toBe('project registry: extra: unknown key')
    const doc = sampleDoc()
    doc.projects['sample-repo'].colour = 'blue'
    expect(refusal(doc)).toBe('project registry: projects.sample-repo.colour: unknown key')
    const ws = sampleDoc()
    ws.workspaces['ws-test'].owner = 'dev'
    expect(refusal(ws)).toBe('project registry: workspaces.ws-test.owner: unknown key')
  })

  it('refuses a missing key', () => {
    const doc = sampleDoc()
    delete doc.projects['loose-repo'].vault_folder
    expect(refusal(doc)).toBe('project registry: projects.loose-repo.vault_folder: is required')
  })

  it('refuses a project whose workspace is absent from the registry', () => {
    const doc = sampleDoc()
    doc.projects['sample-repo'].workspace = 'ws-missing'
    expect(refusal(doc)).toBe(
      'project registry: projects.sample-repo.workspace: must name a workspace of this registry or be null',
    )
  })

  it('refuses a prefix that names two vault folders, across projects and workspaces', () => {
    const doc = sampleDoc()
    doc.projects['loose-repo'].register_prefix = 'TST'
    expect(refusal(doc)).toBe('project registry: projects.loose-repo.register_prefix: prefix already names another vault folder')
    const crossed = sampleDoc()
    crossed.projects['loose-repo'].register_prefix = 'TSTW'
    crossed.projects['loose-repo'].vault_folder = 'Elsewhere'
    expect(refusal(crossed)).toBe(
      'project registry: projects.loose-repo.register_prefix: prefix already names another vault folder',
    )
  })

  it('accepts repositories that keep their rulings in one folder sharing its prefix', () => {
    const doc = sampleDoc()
    doc.projects['loose-repo'] = { workspace: 'ws-test', vault_folder: 'Sample Workspace', register_prefix: 'TSTW' }
    doc.projects['third-repo'] = { workspace: 'ws-test', vault_folder: 'Sample Workspace', register_prefix: 'TSTW' }
    const registry = parseProjectRegistry(doc)
    expect([...registry.projects.values()].filter((p) => p.registerPrefix === 'TSTW').map((p) => p.id)).toEqual([
      'loose-repo',
      'third-repo',
    ])
  })

  it('refuses a vault folder given a second prefix', () => {
    const doc = sampleDoc()
    doc.projects['loose-repo'].vault_folder = 'Sample Repo'
    doc.projects['loose-repo'].register_prefix = 'TSTX'
    expect(refusal(doc)).toBe('project registry: projects.loose-repo.register_prefix: vault folder already has another prefix')
  })

  it('refuses an id that is both a project and a workspace', () => {
    const doc = sampleDoc()
    doc.projects['ws-other'] = { workspace: null, vault_folder: null, register_prefix: null }
    expect(refusal(doc)).toBe('project registry: projects.ws-other: id is also a workspace')
  })

  it('refuses bad ids, prefixes, folders and roots', () => {
    const badId = sampleDoc()
    badId.projects['-bad'] = { workspace: null, vault_folder: null, register_prefix: null }
    expect(refusal(badId)).toMatch(/^project registry: projects\["-bad"\]: id must match/)
    const badPrefix = sampleDoc()
    badPrefix.projects['sample-repo'].register_prefix = 'tst'
    expect(refusal(badPrefix)).toBe('project registry: projects.sample-repo.register_prefix: must be 2 to 6 capital letters or null')
    const badFolder = sampleDoc()
    badFolder.projects['sample-repo'].vault_folder = ''
    expect(refusal(badFolder)).toMatch(/^project registry: projects\.sample-repo\.vault_folder: /)
    const badRoot = sampleDoc()
    badRoot.workspaces['ws-other'].root = 'relative/dir'
    expect(refusal(badRoot)).toMatch(/^project registry: workspaces\.ws-other\.root: must be an absolute path/)
  })

  it('does not treat inherited object keys as registry entries', () => {
    const registry = parseProjectRegistry(sampleDoc())
    expect(registry.projects.get('constructor')).toBeUndefined()
    expect(resolveEventScope(registry, withProject({ id: 'constructor', workspace: null }))).toEqual({
      projectId: null,
      workspaceId: null,
      rejected: { project: 'constructor' },
    })
  })
})

describe('loadProjectRegistry', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('reads a valid file, and throws on a missing or invalid one', () => {
    dir = mkdtempSync(join(tmpdir(), 'registry-'))
    const path = join(dir, 'projects.json')
    writeFileSync(path, JSON.stringify(sampleDoc()))
    expect(loadProjectRegistry(path).projects.has('sample-repo')).toBe(true)
    expect(() => loadProjectRegistry(join(dir, 'absent.json'))).toThrow(/cannot read .*absent\.json \(ENOENT\)/)
    writeFileSync(path, '{ not json')
    expect(() => loadProjectRegistry(path)).toThrow(/is not valid JSON/)
    writeFileSync(path, JSON.stringify({ ...sampleDoc(), version: 2 }))
    expect(() => loadProjectRegistry(path)).toThrow('project registry: version: must be 1')
  })
})

describe('registryRows', () => {
  it('lists workspaces before projects, with the project workspace ids', () => {
    expect(registryRows(parseProjectRegistry(sampleDoc()))).toEqual([
      { id: 'ws-test', kind: 'workspace', workspaceId: null, vaultFolder: 'Sample Workspace', registerPrefix: 'TSTW' },
      { id: 'ws-other', kind: 'workspace', workspaceId: null, vaultFolder: null, registerPrefix: null },
      { id: 'sample-repo', kind: 'project', workspaceId: 'ws-test', vaultFolder: 'Sample Repo', registerPrefix: 'TST' },
      { id: 'loose-repo', kind: 'project', workspaceId: null, vaultFolder: null, registerPrefix: null },
    ])
  })
})

describe('resolveEventScope', () => {
  const registry = parseProjectRegistry(sampleDoc())

  it("takes a registered project's workspace from the registry over the sent one", () => {
    expect(resolveEventScope(registry, withProject({ id: 'sample-repo', workspace: 'ws-other' }))).toEqual({
      projectId: 'sample-repo',
      workspaceId: 'ws-test',
      rejected: {},
    })
    expect(resolveEventScope(registry, withProject({ id: 'loose-repo', workspace: 'ws-test' }))).toEqual({
      projectId: 'loose-repo',
      workspaceId: null,
      rejected: {},
    })
  })

  it('gives NULL and project_rejected for a worktree name', () => {
    expect(resolveEventScope(registry, withProject({ id: 'sample-repo-feature', workspace: null }))).toEqual({
      projectId: null,
      workspaceId: null,
      rejected: { project: 'sample-repo-feature' },
    })
  })

  it('gives the workspace only for a workspace-root event', () => {
    expect(resolveEventScope(registry, withProject({ id: null, workspace: 'ws-test' }))).toEqual({
      projectId: null,
      workspaceId: 'ws-test',
      rejected: {},
    })
  })

  it('reports an unregistered workspace, and keeps a registered one beside a rejected project', () => {
    expect(resolveEventScope(registry, withProject({ id: null, workspace: 'ws-unknown' }))).toEqual({
      projectId: null,
      workspaceId: null,
      rejected: { workspace: 'ws-unknown' },
    })
    expect(resolveEventScope(registry, withProject({ id: 'sample-repo-feature', workspace: 'ws-test' }))).toEqual({
      projectId: null,
      workspaceId: 'ws-test',
      rejected: { project: 'sample-repo-feature' },
    })
  })

  it('resolves a project register entry under its prefix and rejects it under another', () => {
    expect(resolveEventScope(registry, registerEntry('R-TST-1', 'project:sample-repo'))).toEqual({
      projectId: 'sample-repo',
      workspaceId: 'ws-test',
      rejected: {},
    })
    const other = parseProjectRegistry({
      ...sampleDoc(),
      projects: { 'sample-repo': { workspace: 'ws-test', vault_folder: null, register_prefix: 'ABC' } },
    })
    const result = resolveEventScope(other, registerEntry('R-TST-1', 'project:sample-repo'))
    expect(result).toEqual({ reject: "payload.scope: names no registry project with the entry id's prefix" })
  })

  it('resolves workspace and global register entries by prefix', () => {
    expect(resolveEventScope(registry, registerEntry('R-TSTW-4', 'workspace:ws-test'))).toEqual({
      projectId: null,
      workspaceId: 'ws-test',
      rejected: {},
    })
    expect(resolveEventScope(registry, registerEntry('R-TST-4', 'workspace:ws-test'))).toHaveProperty('reject')
    expect(resolveEventScope(registry, registerEntry('R-TSTG-2', 'global'))).toEqual({
      projectId: null,
      workspaceId: null,
      rejected: {},
    })
    expect(resolveEventScope(registry, registerEntry('R-TST-2', 'global'))).toEqual({
      reject: "payload.scope: a global entry's id prefix belongs to a registry project or workspace",
    })
    expect(resolveEventScope(registry, registerEntry('R-TST-3', 'project:loose-repo'))).toHaveProperty('reject')
  })
})

describe('startProjectSync', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries every interval and is ready only after the third attempt succeeds', async () => {
    vi.useFakeTimers()
    const registry = parseProjectRegistry(sampleDoc())
    const calls: ProjectRow[][] = []
    const store = {
      syncProjects: vi.fn(async (rows: readonly ProjectRow[]) => {
        calls.push([...rows])
        if (calls.length < 3) throw new Error('syncProjects failed (PGRST000): connection refused')
        return rows.length
      }),
    }
    const log = vi.fn()
    const sync = startProjectSync(store, registry, log)

    await vi.advanceTimersByTimeAsync(0)
    expect(store.syncProjects).toHaveBeenCalledTimes(1)
    expect(sync.ready()).toBeNull()

    await vi.advanceTimersByTimeAsync(PROJECT_SYNC_RETRY_MS - 1)
    expect(store.syncProjects).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.syncProjects).toHaveBeenCalledTimes(2)
    expect(sync.ready()).toBeNull()

    await vi.advanceTimersByTimeAsync(PROJECT_SYNC_RETRY_MS)
    expect(store.syncProjects).toHaveBeenCalledTimes(3)
    expect(sync.ready()).toBe(registry)
    expect(calls[2]).toEqual(registryRows(registry))

    await vi.advanceTimersByTimeAsync(PROJECT_SYNC_RETRY_MS * 3)
    expect(store.syncProjects).toHaveBeenCalledTimes(3)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^project registry sync failed, retrying in 30 s: /))
    sync.stop()
  })

  it('schedules no retry after stop()', async () => {
    vi.useFakeTimers()
    const store = { syncProjects: vi.fn(async () => Promise.reject(new Error('down'))) }
    const sync = startProjectSync(store, parseProjectRegistry(sampleDoc()), () => {})
    await vi.advanceTimersByTimeAsync(0)
    sync.stop()
    await vi.advanceTimersByTimeAsync(PROJECT_SYNC_RETRY_MS * 3)
    expect(store.syncProjects).toHaveBeenCalledTimes(1)
    expect(sync.ready()).toBeNull()
  })
})
