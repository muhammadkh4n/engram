/**
 * Tests for the project backfill that works without a stored tag: a Claude
 * session → project map, configured roots over a recorded cwd, retagging a
 * worktree's name to its repository, and the rollback record every apply
 * keeps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PageCursor } from '../src/ingest/embed-backfill-lib.js'
import {
  EMPTY_RULES,
  ROLLBACK_CSV_HEADER,
  collectProjectCounts,
  formatEvidenceReport,
  formatRetagProposals,
  PROJECT_TABLES,
  openRollbackCsv,
  parseRollbackCsv,
  parseRootsFile,
  parseSessionMap,
  proposeWorktreeRetags,
  readRollbackCsv,
  resolveEpisodeProject,
  runEvidenceBackfill,
  runRetag,
  runRollback,
  sessionIdFromTranscriptPath,
  type ProjectChange,
  type ProjectRetagStore,
  type ProjectTable,
  type TaggedRow,
  type UntaggedEpisode,
} from '../src/ingest/project-backfill-lib.js'
import { UsageError, parseBackfillArgs } from '../src/ingest/engram-project-backfill-cli.js'

interface Row {
  id: string
  created_at: string
  project_id: string | null
  session_id: string | null
  transcript_path: string | null
  cwd: string | null
  category: string | null
  content: string
}

function keysetAfter(cursor: PageCursor | null) {
  return (r: { created_at: string; id: string }) =>
    !cursor || r.created_at > cursor.createdAt || (r.created_at === cursor.createdAt && r.id > cursor.id)
}

/** In-memory project-tagged tables with the PostgREST store's filter and keyset semantics. */
class StubStore implements ProjectRetagStore {
  readonly writes: Array<{ table: ProjectTable; ids: string[]; from: string | null; to: string | null }> = []
  failWrites = false
  readonly tables: Record<ProjectTable, Row[]>
  constructor(tables: Partial<Record<ProjectTable, Row[]>>) {
    this.tables = { memory_episodes: [], memory_digests: [], memory_semantic: [], memory_procedural: [], ...tables }
  }

  private sorted(table: ProjectTable): Row[] {
    return [...this.tables[table]].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  }

  async fetchUntaggedEpisodes(since: string | null, cursor: PageCursor | null, pageSize: number): Promise<UntaggedEpisode[]> {
    return this.sorted('memory_episodes')
      .filter((r) => r.project_id === null && (since === null || r.created_at >= since))
      .filter(keysetAfter(cursor))
      .slice(0, pageSize)
      .map(({ id, created_at, session_id, transcript_path, cwd, category }) => ({
        id,
        created_at,
        session_id,
        transcript_path,
        cwd,
        category,
      }))
  }

  async fetchTagged(table: ProjectTable, project: string | null, cursor: PageCursor | null, pageSize: number): Promise<TaggedRow[]> {
    return this.sorted(table)
      .filter((r) => (project === null ? r.project_id !== null : r.project_id === project))
      .filter(keysetAfter(cursor))
      .slice(0, pageSize)
      .map(({ id, created_at, project_id }) => ({ id, created_at, project_id: project_id! }))
  }

  async setProject(table: ProjectTable, ids: readonly string[], from: string | null, to: string | null): Promise<string[]> {
    if (this.failWrites) throw new Error('connection reset')
    this.writes.push({ table, ids: [...ids], from, to })
    const changed: string[] = []
    for (const r of this.tables[table]) {
      if (ids.includes(r.id) && r.project_id === from) {
        r.project_id = to
        changed.push(r.id)
      }
    }
    return changed
  }

  projects(table: ProjectTable): Record<string, string | null> {
    return Object.fromEntries(this.tables[table].map((r) => [r.id, r.project_id]))
  }
}

let seq = 0
function row(partial: Partial<Row>): Row {
  seq++
  const n = String(seq).padStart(4, '0')
  return {
    id: `row-${n}`,
    created_at: `2026-10-01T16:${String(seq % 60).padStart(2, '0')}:00.${n}Z`,
    project_id: null,
    session_id: null,
    transcript_path: null,
    cwd: null,
    category: 'fact',
    content: `SECRET-CONTENT-${n} discussion of the deploy`,
    ...partial,
  }
}

const SID_REPO = '11111111-1111-4111-8111-111111111111'
const SID_ROOT = '22222222-2222-4222-8222-222222222222'
const SID_SHARED = '33333333-3333-4333-8333-333333333333'
const SUMMARY_SID = 'claude-code-session-summary'

const sessions = parseSessionMap({
  [SID_REPO]: { cwd: '/home/u/projects/engram', project: 'engram', source: 'detected' },
  [SID_ROOT]: { cwd: '/home/u/projects/workspace/sub', project: 'workspace', source: 'root' },
  [SID_SHARED]: { cwd: '/tmp/scratch', project: null, source: 'unscoped' },
  errors: [{ file: '/x/broken.jsonl', error: 'no line carries a cwd' }],
})
const roots = parseRootsFile({ roots: { '/home/u/projects/workspace': 'workspace' } }, 'groups.json')

function sink(): { changes: ProjectChange[]; write(c: readonly ProjectChange[]): void } {
  const changes: ProjectChange[] = []
  return { changes, write: (c) => void changes.push(...c) }
}

describe('parseSessionMap', () => {
  it('maps sessions with a project, skipping shared ones and the errors list', () => {
    expect([...sessions]).toEqual([
      [SID_REPO, 'engram'],
      [SID_ROOT, 'workspace'],
    ])
  })

  it('rejects a document that is not an object of entries', () => {
    expect(() => parseSessionMap([])).toThrow(/JSON object/)
    expect(() => parseSessionMap({ [SID_REPO]: 'engram' })).toThrow(/entry must be an object/)
  })
})

describe('resolveEpisodeProject', () => {
  it('uses the episode session id first', () => {
    expect(resolveEpisodeProject(row({ session_id: SID_REPO }), { sessions })).toEqual({
      target: 'engram',
      source: 'session',
    })
  })

  it('reads a summary session from metadata.transcriptPath', () => {
    const summary = row({
      session_id: SUMMARY_SID,
      transcript_path: `/home/u/.claude/projects/-home-u-projects-workspace/${SID_ROOT}.jsonl`,
    })
    expect(resolveEpisodeProject(summary, { sessions })).toEqual({ target: 'workspace', source: 'transcript' })
    expect(sessionIdFromTranscriptPath('/a/b/notes.txt')).toBeNull()
  })

  it('falls back to the longest root containing the recorded cwd, on whole path segments', () => {
    const inRoot = row({ cwd: '/home/u/projects/workspace/aih-mfe' })
    expect(resolveEpisodeProject(inRoot, { sessions, roots })).toEqual({ target: 'workspace', source: 'root' })
    expect(resolveEpisodeProject(row({ cwd: '/home/u/projects/workspace2' }), { roots })).toEqual({
      target: null,
      reason: 'no-evidence',
    })
  })

  it('ignores the cwd when no roots are given and a session that resolved shared', () => {
    expect(resolveEpisodeProject(row({ cwd: '/home/u/projects/workspace' }), { sessions }).target).toBeNull()
    expect(resolveEpisodeProject(row({ session_id: SID_SHARED }), { sessions }).target).toBeNull()
  })

  it('keeps cross-cutting categories shared whatever the evidence', () => {
    for (const category of ['preference', 'identity', 'emotional_signal']) {
      expect(resolveEpisodeProject(row({ session_id: SID_REPO, category }), { sessions })).toEqual({
        target: null,
        reason: 'cross-cutting',
      })
    }
  })
})

describe('runEvidenceBackfill', () => {
  function fixture(): StubStore {
    seq = 0
    return new StubStore({
      memory_episodes: [
        row({ session_id: SID_REPO }),
        row({ session_id: SID_REPO, category: 'preference' }),
        row({ session_id: SUMMARY_SID, transcript_path: `/t/${SID_ROOT}.jsonl` }),
        row({ session_id: 'unknown-session', cwd: '/home/u/projects/workspace' }),
        row({ session_id: SID_SHARED, cwd: '/tmp/scratch' }),
        row({ session_id: SID_REPO, project_id: 'engram' }),
      ],
      memory_digests: [],
    })
  }

  it('dry run counts per source and per project and writes nothing', async () => {
    const store = fixture()
    const before = store.projects('memory_episodes')
    const report = await runEvidenceBackfill(store, { sessions, roots }, { apply: false, pageSize: 2, batchSize: 10, since: null })
    expect(store.writes).toEqual([])
    expect(store.projects('memory_episodes')).toEqual(before)
    expect(report.scanned).toBe(5)
    expect(Object.fromEntries([...report.assignments].map(([p, ids]) => [p, ids.length]))).toEqual({
      engram: 1,
      workspace: 2,
    })
    expect(Object.fromEntries(report.unresolved)).toEqual({ 'cross-cutting': 1, 'no-evidence': 1 })

    const text = formatEvidenceReport(report, false)
    expect(text).toContain('  session: 1')
    expect(text).toContain('  transcript: 1')
    expect(text).toContain('  root: 1')
    expect(text).not.toMatch(/SECRET-CONTENT|row-0/)
  })

  it('apply tags only NULL episodes, records each batch first, and rollback restores them', async () => {
    const store = fixture()
    const before = store.projects('memory_episodes')
    const rollback = sink()
    const report = await runEvidenceBackfill(store, { sessions, roots }, {
      apply: true,
      pageSize: 2,
      batchSize: 1,
      since: null,
      rollback,
    })
    expect(report.updated.get('workspace')).toBe(2)
    expect(store.projects('memory_episodes')).toEqual({
      ...before,
      'row-0001': 'engram',
      'row-0003': 'workspace',
      'row-0004': 'workspace',
    })
    expect(rollback.changes.map((c) => [c.table, c.id, c.old, c.new])).toEqual(
      expect.arrayContaining([
        ['memory_episodes', 'row-0001', null, 'engram'],
        ['memory_episodes', 'row-0003', null, 'workspace'],
        ['memory_episodes', 'row-0004', null, 'workspace'],
      ]),
    )

    const restored = await runRollback(store, rollback.changes, { apply: true, batchSize: 2 })
    expect(restored.tables.get('memory_episodes')).toEqual({ listed: 3, restored: 3 })
    expect(store.projects('memory_episodes')).toEqual(before)
  })

  it('reads only episodes created at or after --since', async () => {
    const store = fixture()
    const since = store.tables.memory_episodes[2]!.created_at
    const report = await runEvidenceBackfill(store, { sessions, roots }, { apply: false, pageSize: 10, batchSize: 10, since })
    expect(report.scanned).toBe(3)
  })

  it('records a batch before writing it, so a failed write can still be rolled back', async () => {
    const store = fixture()
    store.failWrites = true
    const rollback = sink()
    await expect(
      runEvidenceBackfill(store, { sessions }, { apply: true, pageSize: 10, batchSize: 10, since: null, rollback }),
    ).rejects.toThrow(/connection reset/)
    expect(rollback.changes).toHaveLength(1)
  })

  it('refuses to apply without a rollback record', async () => {
    await expect(
      runEvidenceBackfill(fixture(), { sessions }, { apply: true, pageSize: 10, batchSize: 10, since: null }),
    ).rejects.toThrow(/rollback/)
  })
})

describe('runRetag', () => {
  function fixture(): StubStore {
    seq = 0
    return new StubStore({
      memory_episodes: [
        row({ project_id: 'engram-project-roots' }),
        row({ project_id: 'engram-project-roots' }),
        row({ project_id: 'engram' }),
        row({ project_id: null }),
      ],
      memory_digests: [row({ project_id: 'engram-project-roots' }), row({ project_id: 'aithentic-sam-mfe-2857' })],
      memory_semantic: [row({ project_id: 'engram-project-roots' }), row({ project_id: 'aithentic-sam-mfe-2857' })],
      memory_procedural: [row({ project_id: 'engram-project-roots' }), row({ project_id: null })],
    })
  }
  const pairs = [{ from: 'engram-project-roots', to: 'engram' }]

  it('dry run counts every project-tagged table and writes nothing', async () => {
    const store = fixture()
    const report = await runRetag(store, pairs, { apply: false, pageSize: 1, batchSize: 10 })
    expect(store.writes).toEqual([])
    expect(Object.fromEntries(report.pairs[0]!.tables)).toEqual({
      memory_episodes: { planned: 2, updated: 0 },
      memory_digests: { planned: 1, updated: 0 },
      memory_semantic: { planned: 1, updated: 0 },
      memory_procedural: { planned: 1, updated: 0 },
    })
  })

  it('apply moves episodes, digests and facts, and rollback puts the worktree name back on all four', async () => {
    const store = fixture()
    const before = Object.fromEntries(PROJECT_TABLES.map((t) => [t, store.projects(t)]))
    const rollback = sink()
    const report = await runRetag(store, pairs, { apply: true, pageSize: 1, batchSize: 1, rollback })
    expect([...report.pairs[0]!.tables.values()].map((t) => t.updated)).toEqual([2, 1, 1, 1])
    expect(Object.values(store.projects('memory_episodes'))).toEqual(['engram', 'engram', 'engram', null])
    expect(Object.values(store.projects('memory_digests'))).toEqual(['engram', 'aithentic-sam-mfe-2857'])
    expect(Object.values(store.projects('memory_semantic'))).toEqual(['engram', 'aithentic-sam-mfe-2857'])
    expect(Object.values(store.projects('memory_procedural'))).toEqual(['engram', null])
    expect(rollback.changes.every((c) => c.old === 'engram-project-roots' && c.new === 'engram')).toBe(true)
    expect(new Set(rollback.changes.map((c) => c.table))).toEqual(new Set(PROJECT_TABLES))

    const restored = await runRollback(store, rollback.changes, { apply: true, batchSize: 10 })
    expect([...restored.tables.values()].map((t) => t.restored)).toEqual([2, 1, 1, 1])
    expect(Object.fromEntries(PROJECT_TABLES.map((t) => [t, store.projects(t)]))).toEqual(before)
  })

  it('rejects chained or repeated pairs, which would make the dry run differ from the apply', async () => {
    const chained = [
      { from: 'a-wt', to: 'a' },
      { from: 'a', to: 'b' },
    ]
    await expect(runRetag(fixture(), chained, { apply: false, pageSize: 10, batchSize: 10 })).rejects.toThrow(/chains/)
  })

  it('--fold-worktrees proposes worktree → repository pairs from the stored projects', async () => {
    const store = fixture()
    store.tables.memory_digests.push(row({ project_id: 'aithentic-sam-mfe' }))
    const counts = await collectProjectCounts(store, 2)
    const proposals = proposeWorktreeRetags(counts, EMPTY_RULES)
    expect(proposals).toEqual([
      {
        from: 'aithentic-sam-mfe-2857',
        to: 'aithentic-sam-mfe',
        rows: 2,
        tables: { memory_digests: 1, memory_semantic: 1 },
      },
      {
        from: 'engram-project-roots',
        to: 'engram',
        rows: 5,
        tables: { memory_episodes: 2, memory_digests: 1, memory_semantic: 1, memory_procedural: 1 },
      },
    ])
    expect(formatRetagProposals(proposals)).toContain(
      '--retag engram-project-roots=engram   # 5 rows (memory_episodes 2, memory_digests 1, memory_semantic 1, memory_procedural 1)',
    )
    const kept = { ...EMPTY_RULES, keep: new Set(['engram-project-roots']) }
    expect(proposeWorktreeRetags(counts, kept).map((p) => p.from)).toEqual(['aithentic-sam-mfe-2857'])
  })
})

describe('runRollback', () => {
  it('dry run restores nothing; apply leaves rows changed again since the apply alone', async () => {
    seq = 0
    const store = new StubStore({
      memory_episodes: [row({ project_id: 'engram' }), row({ project_id: 'mission-control' })],
      memory_digests: [],
    })
    const changes: ProjectChange[] = [
      { table: 'memory_episodes', id: 'row-0001', old: null, new: 'engram' },
      { table: 'memory_episodes', id: 'row-0002', old: null, new: 'engram' },
    ]
    const dry = await runRollback(store, changes, { apply: false, batchSize: 10 })
    expect(dry.tables.get('memory_episodes')).toEqual({ listed: 2, restored: 0 })
    expect(store.writes).toEqual([])

    const applied = await runRollback(store, changes, { apply: true, batchSize: 10 })
    expect(applied.tables.get('memory_episodes')).toEqual({ listed: 2, restored: 1 })
    expect(store.projects('memory_episodes')).toEqual({ 'row-0001': null, 'row-0002': 'mission-control' })
  })
})

describe('rollback CSV', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'engram-rollback-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips through a new file and never overwrites an existing one', () => {
    const path = join(dir, 'run.csv')
    const csv = openRollbackCsv(path)
    const changes: ProjectChange[] = [
      { table: 'memory_episodes', id: 'a1', old: null, new: 'engram' },
      { table: 'memory_digests', id: 'd1', old: 'odd,"name"', new: 'engram' },
      { table: 'memory_semantic', id: 's1', old: 'engram-project-roots', new: 'engram' },
      { table: 'memory_procedural', id: 'p1', old: 'engram-project-roots', new: 'engram' },
    ]
    csv.write(changes)
    csv.close()
    expect(readFileSync(path, 'utf8').split('\n')[0]).toBe(ROLLBACK_CSV_HEADER)
    expect(readRollbackCsv(path)).toEqual(changes)
    expect(() => openRollbackCsv(path)).toThrow(/EEXIST/)
  })

  it('rejects a foreign header or a table the tool does not write', () => {
    expect(() => parseRollbackCsv('tier,id,project_id\n')).toThrow(/must start with/)
    expect(() => parseRollbackCsv(`${ROLLBACK_CSV_HEADER}\nmemory_entities,e1,,engram\n`)).toThrow(/line 2/)
  })
})

describe('parseBackfillArgs', () => {
  function usage(argv: string[]): string {
    try {
      parseBackfillArgs(argv)
    } catch (err) {
      if (err instanceof UsageError) return err.message
      throw err
    }
    return ''
  }

  it('selects a mode and keeps the dry-run default', () => {
    const args = parseBackfillArgs(['--sessions', 'map.json', '--roots', 'g.json', '--since', '2026-10-01T16:00:00Z'])
    expect(args).toMatchObject({ mode: 'evidence', apply: false, since: '2026-10-01T16:00:00.000Z' })
    expect(parseBackfillArgs([])).toMatchObject({ mode: 'tag' })
    expect(parseBackfillArgs(['--retag', 'engram-x=engram', '--retag', 'b-1=b'])).toMatchObject({
      mode: 'retag',
      retag: [
        { from: 'engram-x', to: 'engram' },
        { from: 'b-1', to: 'b' },
      ],
    })
  })

  it('rejects conflicting or misplaced flags', () => {
    expect(usage(['--sessions', 'm.json', '--retag', 'a-1=a'])).toMatch(/one mode/)
    expect(usage(['--fold-worktrees', '--apply'])).toMatch(/only proposes/)
    expect(usage(['--retag', 'a-1=a', '--since', '2026-10-01'])).toMatch(/--since applies only/)
    expect(usage(['--retag', 'a-1=a', '--keep', 'x'])).toMatch(/tag mode/)
    expect(usage(['--retag', 'a-1=none'])).toMatch(/project as TO/)
    expect(usage(['--rollback-out', 'x.csv'])).toMatch(/--rollback-out/)
  })
})
