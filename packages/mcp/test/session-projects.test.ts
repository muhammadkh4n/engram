/**
 * Tests for the Claude session → project map built from transcripts.
 *
 * Per-turn captures keep only the Claude session id, so this map is the only
 * way to recover the project a capture came from; each entry must resolve
 * the transcript's cwd exactly as a live capture would.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatSessionMap,
  mapSessionProjects,
  parseSessionMapArgs,
} from '../src/ingest/session-projects-cli.js'
import { resetProjectRootsWarning } from '../src/ingest/project-roots.js'

function transcript(cwd: string, sid: string): string {
  return [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: sid }),
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'm1' }),
    JSON.stringify({ type: 'user', sessionId: sid, cwd, message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ type: 'assistant', sessionId: sid, cwd: '/somewhere/else' }),
  ].join('\n') + '\n'
}

describe('mapSessionProjects', () => {
  let base: string
  let transcripts: string
  let workspace: string
  let repo: string
  let outside: string
  let groupsFile: string

  beforeEach(() => {
    resetProjectRootsWarning()
    base = mkdtempSync(join(tmpdir(), 'engram-session-projects-'))
    transcripts = join(base, 'projects')
    workspace = join(base, 'workspace')
    repo = join(base, 'code', 'alpha')
    outside = join(base, 'scratch')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(workspace, 'notes'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    groupsFile = join(base, 'groups.json')
    writeFileSync(groupsFile, JSON.stringify({ groups: {}, roots: { [workspace]: 'acme' } }))

    mkdirSync(join(transcripts, '-code-alpha'), { recursive: true })
    mkdirSync(join(transcripts, '-workspace'), { recursive: true })
    mkdirSync(join(transcripts, '-scratch'), { recursive: true })
    writeFileSync(join(transcripts, '-code-alpha', 'sid-repo.jsonl'), transcript(join(repo, 'src'), 'sid-repo'))
    writeFileSync(join(transcripts, '-workspace', 'sid-root.jsonl'), transcript(join(workspace, 'notes'), 'sid-root'))
    writeFileSync(join(transcripts, '-scratch', 'sid-out.jsonl'), transcript(outside, 'sid-out'))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('maps a repository, a configured root and an unscoped directory', async () => {
    const map = await mapSessionProjects({ transcriptsDir: transcripts, groupsFile })

    expect(map.sessions['sid-repo']).toEqual({ cwd: join(repo, 'src'), project: 'alpha', source: 'detected' })
    expect(map.sessions['sid-root']).toEqual({ cwd: join(workspace, 'notes'), project: 'acme', source: 'root' })
    expect(map.sessions['sid-out']).toEqual({ cwd: outside, project: null, source: 'unscoped' })
    expect(map.errors).toEqual([])
  })

  it('without a groups file the root session is unscoped', async () => {
    const map = await mapSessionProjects({ transcriptsDir: transcripts })

    expect(map.sessions['sid-root']).toEqual({ cwd: join(workspace, 'notes'), project: null, source: 'unscoped' })
    expect(map.sessions['sid-repo']?.project).toBe('alpha')
  })

  it('--since keeps only transcripts modified at or after the instant', async () => {
    const old = new Date('2026-01-01T00:00:00Z')
    utimesSync(join(transcripts, '-code-alpha', 'sid-repo.jsonl'), old, old)
    utimesSync(join(transcripts, '-scratch', 'sid-out.jsonl'), old, old)

    const map = await mapSessionProjects({
      transcriptsDir: transcripts,
      groupsFile,
      since: new Date('2026-06-01T00:00:00Z'),
    })

    expect(Object.keys(map.sessions)).toEqual(['sid-root'])
  })

  it('lists unreadable and cwd-less transcripts under errors without throwing', async () => {
    writeFileSync(join(transcripts, '-scratch', 'sid-empty.jsonl'), '{"type":"summary"}\nnot json\n')
    mkdirSync(join(transcripts, '-scratch', 'sid-dir.jsonl'))

    const map = await mapSessionProjects({ transcriptsDir: transcripts, groupsFile })

    expect(map.sessions['sid-empty']).toBeUndefined()
    expect(map.sessions['sid-dir']).toBeUndefined()
    const files = map.errors.map((e) => e.file).sort()
    expect(files).toEqual([
      join(transcripts, '-scratch', 'sid-dir.jsonl'),
      join(transcripts, '-scratch', 'sid-empty.jsonl'),
    ])
    expect(map.sessions['sid-out']?.source).toBe('unscoped')
  })

  it('ignores an explicit ENGRAM_PROJECT_ID so every session resolves from its own cwd', async () => {
    const saved = process.env['ENGRAM_PROJECT_ID']
    process.env['ENGRAM_PROJECT_ID'] = 'forced'
    try {
      const map = await mapSessionProjects({ transcriptsDir: transcripts, groupsFile })
      expect(map.sessions['sid-repo']?.project).toBe('alpha')
      expect(map.sessions['sid-out']?.project).toBeNull()
    } finally {
      if (saved === undefined) delete process.env['ENGRAM_PROJECT_ID']
      else process.env['ENGRAM_PROJECT_ID'] = saved
    }
  })

  it('reports a missing transcripts directory as an error', async () => {
    const map = await mapSessionProjects({ transcriptsDir: join(base, 'nope') })

    expect(map.errors).toHaveLength(1)
    expect(map.errors[0]?.file).toBe(join(base, 'nope'))
  })
})

describe('session map output and arguments', () => {
  it('prints session ids at the top level beside errors', () => {
    const doc = JSON.parse(
      formatSessionMap({
        sessions: { s1: { cwd: '/r/a', project: 'a', source: 'detected' } },
        errors: [{ file: '/t/x.jsonl', error: 'boom' }],
      }),
    )
    expect(doc).toEqual({
      s1: { cwd: '/r/a', project: 'a', source: 'detected' },
      errors: [{ file: '/t/x.jsonl', error: 'boom' }],
    })
  })

  it('parses --transcripts, --since and the groups file from the environment', () => {
    const opts = parseSessionMapArgs(['--transcripts', '/t', '--since', '2026-10-01T00:00:00Z'], {
      ENGRAM_PROJECT_GROUPS_FILE: '/g.json',
    })
    expect(opts).toEqual({
      transcriptsDir: '/t',
      since: new Date('2026-10-01T00:00:00Z'),
      groupsFile: '/g.json',
    })
  })
})
