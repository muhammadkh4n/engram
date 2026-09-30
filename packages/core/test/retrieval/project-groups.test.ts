import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseProjectGroups,
  groupOf,
  loadProjectGroups,
  projectRankingFromEnv,
  projectBoostFor,
  applyProjectRanking,
  resetProjectGroupsCache,
} from '../../src/retrieval/project-groups.js'
import type { RetrievedMemory } from '../../src/types.js'

function mem(id: string, projectId: string | null, relevance: number): RetrievedMemory {
  return { id, type: 'episode', content: id, relevance, source: 'recall', metadata: {}, projectId }
}

describe('parseProjectGroups', () => {
  it('keeps groups in file order with their patterns', () => {
    const groups = parseProjectGroups({ groups: { aithentic: ['aithentic-*', 'tsm-mfe'], engram: ['engram'] } })
    expect(groups.map((g) => g.name)).toEqual(['aithentic', 'engram'])
  })

  it('rejects a document without a groups object', () => {
    expect(() => parseProjectGroups({ aithentic: ['a'] })).toThrow()
    expect(() => parseProjectGroups(null)).toThrow()
  })

  it('rejects a group whose patterns are not strings', () => {
    expect(() => parseProjectGroups({ groups: { a: ['x', 3] } })).toThrow()
    expect(() => parseProjectGroups({ groups: { a: 'x' } })).toThrow()
  })
})

describe('groupOf', () => {
  const groups = parseProjectGroups({
    groups: {
      aithentic: ['aithentic-*', '*-mfe', 'ait_db_schema'],
      tools: ['mission-?ontrol', 'engram*'],
      catchall: ['*'],
    },
  })

  it('matches exact names and globs', () => {
    expect(groupOf('ait_db_schema', groups)).toBe('aithentic')
    expect(groupOf('aithentic-node-stress', groups)).toBe('aithentic')
    expect(groupOf('cih-mfe', groups)).toBe('aithentic')
    expect(groupOf('mission-control', groups)).toBe('tools')
    expect(groupOf('engram-project-scoping', groups)).toBe('tools')
  })

  it('matches case-insensitively and anchors the whole name', () => {
    expect(groupOf('Aithentic-Packages', groups)).toBe('aithentic')
    expect(groupOf('xait_db_schema', parseProjectGroups({ groups: { a: ['ait_db_schema'] } }))).toBeNull()
  })

  it('assigns a project to the first group that matches', () => {
    expect(groupOf('engram', groups)).toBe('tools')
    expect(groupOf('dotfiles', groups)).toBe('catchall')
  })

  it('treats regex metacharacters in a pattern literally', () => {
    const g = parseProjectGroups({ groups: { dotted: ['a.b'] } })
    expect(groupOf('a.b', g)).toBe('dotted')
    expect(groupOf('axb', g)).toBeNull()
  })

  it('returns null with no groups', () => {
    expect(groupOf('engram', [])).toBeNull()
  })
})

describe('loadProjectGroups', () => {
  let dir: string
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'engram-groups-'))
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetProjectGroupsCache()
  })

  afterEach(() => {
    warn.mockRestore()
    rmSync(dir, { recursive: true, force: true })
    resetProjectGroupsCache()
  })

  it('reads a valid file', () => {
    const file = join(dir, 'groups.json')
    writeFileSync(file, JSON.stringify({ groups: { engram: ['engram*'] } }))
    expect(groupOf('engram-bench', loadProjectGroups(file))).toBe('engram')
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns no groups and stays silent when the path is unset', () => {
    expect(loadProjectGroups(undefined)).toEqual([])
    expect(loadProjectGroups('')).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns no groups for a missing file and logs once', () => {
    const file = join(dir, 'absent.json')
    expect(loadProjectGroups(file)).toEqual([])
    expect(loadProjectGroups(file)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('returns no groups for malformed JSON or a bad shape and logs once', () => {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not json')
    expect(loadProjectGroups(bad)).toEqual([])
    const shape = join(dir, 'shape.json')
    writeFileSync(shape, JSON.stringify({ groups: { a: [1] } }))
    expect(loadProjectGroups(shape)).toEqual([])
    expect(loadProjectGroups(shape)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('projectRankingFromEnv', () => {
  beforeEach(() => resetProjectGroupsCache())

  it('defaults to +0.10 same project and +0.05 same group', () => {
    const cfg = projectRankingFromEnv('alpha', {})
    expect(cfg.projectBoost).toBeCloseTo(0.1)
    expect(cfg.groupBoost).toBeCloseTo(0.05)
    expect(cfg.strict).toBe(false)
  })

  it('reads the boosts from the environment and ignores invalid values', () => {
    const cfg = projectRankingFromEnv('alpha', { ENGRAM_PROJECT_BOOST: '0.2', ENGRAM_PROJECT_GROUP_BOOST: '0.07' })
    expect(cfg.projectBoost).toBeCloseTo(0.2)
    expect(cfg.groupBoost).toBeCloseTo(0.07)
    const bad = projectRankingFromEnv('alpha', { ENGRAM_PROJECT_BOOST: 'lots', ENGRAM_PROJECT_GROUP_BOOST: '-1' })
    expect(bad.projectBoost).toBeCloseTo(0.1)
    expect(bad.groupBoost).toBeCloseTo(0.05)
  })
})

describe('projectBoostFor / applyProjectRanking', () => {
  const groups = parseProjectGroups({ groups: { aithentic: ['aithentic-*', '*-mfe'] } })
  const ranking = { project: 'aithentic-sam-mfe', group: 'aithentic', groups, projectBoost: 0.1, groupBoost: 0.05, strict: false }

  it('boosts same project, then same group, and leaves shared and other projects alone', () => {
    expect(projectBoostFor('aithentic-sam-mfe', ranking)).toBeCloseTo(0.1)
    expect(projectBoostFor('cih-mfe', ranking)).toBeCloseTo(0.05)
    expect(projectBoostFor(null, ranking)).toBe(0)
    expect(projectBoostFor('engram', ranking)).toBe(0)
  })

  it('gives no group boost when the current project has no group', () => {
    const ungrouped = { ...ranking, project: 'engram', group: null }
    expect(projectBoostFor('cih-mfe', ungrouped)).toBe(0)
    expect(projectBoostFor('engram', ungrouped)).toBeCloseTo(0.1)
  })

  it('falls back to metadata.project when the column is empty', () => {
    const legacy = { ...mem('m', null, 0.4), metadata: { project: 'aithentic-sam-mfe' } }
    const [out] = applyProjectRanking([legacy], ranking)
    expect(out!.relevance).toBeCloseTo(0.5)
  })

  it('keeps every memory in soft mode and drops only other projects in strict mode', () => {
    const input = [mem('mine', 'aithentic-sam-mfe', 0.4), mem('sib', 'cih-mfe', 0.4), mem('other', 'engram', 0.4), mem('shared', null, 0.4)]
    const soft = applyProjectRanking(input, ranking)
    expect(soft.map((m) => m.id)).toEqual(['mine', 'sib', 'other', 'shared'])
    expect(soft.map((m) => m.relevance)).toEqual([0.5, 0.45, 0.4, 0.4].map((n) => expect.closeTo(n)))
    const strict = applyProjectRanking(input, { ...ranking, strict: true })
    expect(strict.map((m) => m.id)).toEqual(['mine', 'shared'])
  })

  it('does not mutate its input', () => {
    const input = [mem('mine', 'aithentic-sam-mfe', 0.4)]
    applyProjectRanking(input, ranking)
    expect(input[0]!.relevance).toBe(0.4)
  })
})

describe('applyProjectRanking on fused scores above 1.0', () => {
  it('keeps a boosted same-project score above an equal other-project score', () => {
    const ranking = { project: 'alpha', group: null, groups: [], projectBoost: 0.1, groupBoost: 0.05, strict: false }
    const [mine, other] = applyProjectRanking([mem('mine', 'alpha', 1.3), mem('other', 'beta', 1.3)], ranking)
    expect(mine!.relevance).toBeCloseTo(1.4)
    expect(mine!.relevance).toBeGreaterThan(other!.relevance)
  })
})
