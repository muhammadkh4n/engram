import { describe, it, expect } from 'vitest'
import {
  formatReconcileReport,
  parseReconcileArgs,
  planReconcile,
  ReconcileArgsError,
  type GraphMemoryNode,
  type SqlMemoryRow,
} from '../src/graph-reconcile-lib.js'

const row = (id: string, over: Partial<SqlMemoryRow> = {}): SqlMemoryRow => ({
  id,
  tier: 'semantic',
  projectId: null,
  inactive: false,
  ...over,
})

const node = (id: string, over: Partial<GraphMemoryNode> = {}): GraphMemoryNode => ({
  id,
  memoryType: 'semantic',
  projectId: null,
  forgotten: false,
  degree: 3,
  ...over,
})

describe('planReconcile', () => {
  it('stamps nodes of inactive rows that lack forgottenAt, and skips already-stamped ones', () => {
    const plan = planReconcile(
      [row('a', { inactive: true }), row('b', { inactive: true }), row('c')],
      [node('a'), node('b', { forgotten: true }), node('c')],
    )
    expect(plan.stamp).toEqual(['a'])
  })

  it('matches ids case-insensitively', () => {
    const plan = planReconcile([row('ABC-1', { inactive: true })], [node('abc-1')])
    expect(plan.stamp).toEqual(['abc-1'])
    expect(plan.missing).toEqual([])
    expect(plan.liveWithoutNode.semantic).toBe(0)
  })

  it('sets the project where SQL has one that differs from the node, never clears one', () => {
    const plan = planReconcile(
      [row('a', { projectId: 'engram' }), row('b', { projectId: 'engram' }), row('c'), row('d', { projectId: 'ouija' })],
      [
        node('a'),
        node('b', { projectId: 'engram' }),
        node('c', { projectId: 'engram' }),
        node('d', { projectId: 'engram' }),
      ],
    )
    expect(plan.setProject).toEqual([
      { id: 'a', projectId: 'engram', before: null },
      { id: 'd', projectId: 'ouija', before: 'engram' },
    ])
  })

  it('lists nodes with no SQL row as missing, untyped nodes included', () => {
    const plan = planReconcile([row('a')], [node('a'), node('ghost'), node('untyped', { memoryType: null })])
    expect(plan.missing).toEqual(['ghost', 'untyped'])
  })

  it('buckets orphans by row state and lists only inactive or missing ones as deletable', () => {
    const plan = planReconcile(
      [row('live'), row('dead', { inactive: true }), row('linked', { inactive: true })],
      [
        node('live', { degree: 0 }),
        node('dead', { degree: 0 }),
        node('gone', { degree: 0 }),
        node('linked', { degree: 2 }),
      ],
    )
    expect(plan.orphans).toEqual({ live: 1, inactive: 1, missing: 1 })
    expect(plan.deletableOrphans).toEqual(['dead', 'gone'])
  })

  it('never lists the node of a live row in any delete list', () => {
    const plan = planReconcile(
      [row('live-1'), row('live-2', { tier: 'episode', projectId: 'engram' })],
      [node('live-1', { degree: 0 }), node('live-2', { degree: 0, memoryType: 'episode' })],
    )
    expect(plan.deletableOrphans).toEqual([])
    expect(plan.missing).toEqual([])
    expect(plan.orphans.live).toBe(2)
  })

  it('counts live rows without a node per tier, ignoring inactive rows', () => {
    const plan = planReconcile(
      [
        row('e1', { tier: 'episode' }),
        row('e2', { tier: 'episode' }),
        row('d1', { tier: 'digest' }),
        row('s1'),
        row('s2', { inactive: true }),
        row('p1', { tier: 'procedural' }),
        row('s3'),
      ],
      [node('s3')],
    )
    expect(plan.liveWithoutNode).toEqual({ episode: 2, digest: 1, semantic: 1, procedural: 1 })
  })

  it('counts tier mismatches, an untyped node with a row among them', () => {
    const plan = planReconcile(
      [row('a', { tier: 'episode' }), row('b', { tier: 'digest' }), row('c')],
      [node('a', { memoryType: 'semantic' }), node('b', { memoryType: null }), node('c')],
    )
    expect(plan.tierMismatch).toBe(2)
  })
})

describe('parseReconcileArgs', () => {
  it('defaults to a dry run with 1000-row pages and batches', () => {
    expect(parseReconcileArgs([])).toEqual({
      apply: false,
      deleteMissing: false,
      deleteOrphans: false,
      undoLog: null,
      pageSize: 1000,
      batchSize: 1000,
      help: false,
    })
  })

  it('accepts every write flag with an undo log', () => {
    const args = parseReconcileArgs([
      '--apply',
      '--delete-missing',
      '--delete-orphans',
      '--undo-log',
      '/tmp/undo.jsonl',
      '--page-size',
      '500',
      '--batch-size',
      '50',
    ])
    expect(args).toMatchObject({
      apply: true,
      deleteMissing: true,
      deleteOrphans: true,
      undoLog: '/tmp/undo.jsonl',
      pageSize: 500,
      batchSize: 50,
    })
  })

  it.each([['--apply'], ['--delete-missing'], ['--delete-orphans']])('rejects %s without --undo-log', (flag) => {
    expect(() => parseReconcileArgs([flag])).toThrow(/--undo-log/)
  })

  it('rejects a delete flag without --apply', () => {
    expect(() => parseReconcileArgs(['--delete-orphans', '--undo-log', 'u.jsonl'])).toThrow(/require --apply/)
  })

  it.each([
    [['--page-size', '0']],
    [['--page-size', 'abc']],
    [['--batch-size', '-3']],
    [['--batch-size']],
    [['--undo-log']],
    [['--undo-log', '--apply']],
    [['--bogus']],
  ])('rejects %j', (argv) => {
    expect(() => parseReconcileArgs(argv)).toThrow(ReconcileArgsError)
  })
})

describe('formatReconcileReport', () => {
  it('prints counts and never an id or project', () => {
    const plan = planReconcile(
      [row('row-secret-id', { inactive: true, projectId: 'private-repo' }), row('live-row-id', { tier: 'episode' })],
      [node('row-secret-id', { degree: 0 }), node('ghost-node-id', { memoryType: null })],
    )
    const report = formatReconcileReport(plan)
    for (const leak of ['row-secret-id', 'ghost-node-id', 'live-row-id', 'private-repo']) {
      expect(report).not.toContain(leak)
    }
    expect(report).toContain('stamp forgottenAt:     1')
    expect(report).toContain('set projectId:         1')
    expect(report).toContain('nodes without a row:   1')
    expect(report).toContain('orphans:               live 0, inactive 1, missing 0')
    expect(report).toContain('deletable orphans:     1')
    expect(report).toContain('episode 1')
  })
})
