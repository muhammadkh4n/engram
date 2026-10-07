/**
 * POST /documents/sync below HTTP: request rules (400), per-note rules
 * (`rejected invalid:<field>`, `excluded`), the mapping from a vault note to
 * its scope, plan and sections, per-note store failures, and the totals.
 */

import { describe, it, expect, vi } from 'vitest'
import type { DocumentNoteSyncResult, DocumentNoteWrite, ScrubResult } from '@engram-mem/core'
import { parseProjectRegistry, type ProjectRegistry } from '../src/capture-events/project-registry.js'
import {
  DOCUMENTS_FAILED_MESSAGE,
  planSlugOf,
  resolveNoteScope,
  runDocumentsRequest,
  type DocumentsAccepted,
  type DocumentsRouteDeps,
} from '../src/documents-route.js'

const NOW = new Date('2026-10-06T12:00:00Z')
const SEEN_AT = '2026-10-06T11:00:00Z'
const MTIME = '2026-10-06T10:30:00+02:00'
const TEN_MINUTES_AHEAD = '2026-10-06T12:10:00Z'

const REGISTRY: ProjectRegistry = parseProjectRegistry({
  version: 1,
  workspaces: {
    'ws-home': { root: '~/projects/home', vault_folder: 'Home', register_prefix: null },
    'ws-acme': { root: '~/projects/acme', vault_folder: 'Aithentic', register_prefix: null },
  },
  projects: {
    engram: { workspace: 'ws-home', vault_folder: 'Engram', register_prefix: 'TST' },
    'acme-web': { workspace: 'ws-acme', vault_folder: 'Aithentic', register_prefix: null },
    'acme-api': { workspace: 'ws-acme', vault_folder: 'Aithentic', register_prefix: null },
  },
})

const APPLIED: DocumentNoteSyncResult = {
  status: 'applied',
  sections: {
    created: 2,
    superseded: 1,
    unchanged: 0,
    retired: 1,
    restored: 1,
    keptForgotten: 0,
    keptRetired: 0,
    skippedEmpty: 0,
  },
  itemIds: ['00000000-0000-4000-8000-00000000c001'],
}

function note(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path,
    note_version: 'v-1',
    seen_at: SEEN_AT,
    mtime: MTIME,
    deleted: false,
    frontmatter: { tags: ['plan'] },
    sections: [
      { heading_path: [], index: 0, text: 'Intro text.', kind_hint: 'note' },
      { heading_path: ['Goal'], index: 1, text: 'Ship the worker.', kind_hint: 'note' },
    ],
    ...overrides,
  }
}

function body(...notes: Array<Record<string, unknown>>): Record<string, unknown> {
  return { source: 'vault', notes }
}

const noScrub = async (text: string): Promise<ScrubResult> => ({ text, redactions: [] })

function deps(overrides: Partial<DocumentsRouteDeps> = {}): DocumentsRouteDeps & {
  syncDocumentNote: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
} {
  const syncDocumentNote = vi.fn(async (_note: DocumentNoteWrite) => APPLIED)
  const log = vi.fn()
  return {
    store: { syncDocumentNote },
    ready: () => REGISTRY,
    status: () => ({ configured: true, unreadable: [], values: 1 }),
    log,
    now: () => NOW,
    scrub: noScrub,
    syncDocumentNote,
    ...overrides,
  }
}

function sent(d: { syncDocumentNote: ReturnType<typeof vi.fn> }, call = 0): DocumentNoteWrite {
  return d.syncDocumentNote.mock.calls[call]![0] as DocumentNoteWrite
}

describe('runDocumentsRequest: request rules', () => {
  it.each([
    ['an unknown top-level key', { ...body(note('Engram/a.md')), extra: 1 }],
    ['a source other than vault', { source: 'git', notes: [note('Engram/a.md')] }],
    ['an unknown note key', body({ ...note('Engram/a.md'), title: 'x' })],
    ['a note missing a key', body((({ frontmatter: _f, ...rest }) => rest)(note('Engram/a.md')))],
    ['a duplicate path', body(note('Engram/a.md'), note('Engram/a.md'))],
    ['no notes', body()],
    ['201 notes', body(...Array.from({ length: 201 }, (_, i) => note(`Engram/n-${i}.md`)))],
    ['a body that is not an object', ['not', 'an', 'object']],
  ])('answers 400, not retryable, to %s', async (_name, request) => {
    const d = deps()
    const res = await runDocumentsRequest(d, request)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ retryable: false })
    expect(d.syncDocumentNote).not.toHaveBeenCalled()
  })

  it('answers 503 before the project registry syncs and while the secret registry is degraded', async () => {
    const notReady = deps({ ready: () => null })
    expect((await runDocumentsRequest(notReady, body(note('Engram/a.md')))).status).toBe(503)
    const degraded = deps({ status: () => ({ configured: true, unreadable: ['/srv/secrets.env'], values: 0 }) })
    const res = await runDocumentsRequest(degraded, body(note('Engram/a.md')))
    expect(res).toEqual({ status: 503, body: { error: expect.any(String), retryable: true } })
    expect(degraded.syncDocumentNote).not.toHaveBeenCalled()
    expect(JSON.stringify(degraded.log.mock.calls)).not.toContain('Engram/a.md')
  })
})

describe('runDocumentsRequest: per-note rules', () => {
  it.each([
    ['../x.md', note('../x.md'), 'invalid:path'],
    ['/abs.md', note('/abs.md'), 'invalid:path'],
    ['a.txt', note('a.txt'), 'invalid:path'],
    ['a backslash', note('Engram\\a.md'), 'invalid:path'],
    ['an empty segment', note('Engram//a.md'), 'invalid:path'],
    ['a path over 2600 UTF-8 bytes', note(`${'日'.repeat(1000)}.md`), 'invalid:path'],
    ['a blank note_version', note('Engram/b.md', { note_version: '' }), 'invalid:note_version'],
    ['deleted with sections', note('Engram/b.md', { deleted: true, frontmatter: null }), 'invalid:deleted'],
    ['deleted with frontmatter', note('Engram/b.md', { deleted: true, sections: [] }), 'invalid:deleted'],
    ['an unknown kind_hint', note('Engram/b.md', { sections: [{ heading_path: [], index: 0, text: 't', kind_hint: 'memo' }] }), 'invalid:kind_hint'],
    [
      'a non-increasing index',
      note('Engram/b.md', {
        sections: [
          { heading_path: [], index: 3, text: 'a', kind_hint: 'note' },
          { heading_path: ['H'], index: 3, text: 'b', kind_hint: 'note' },
        ],
      }),
      'invalid:index',
    ],
    ['a negative index', note('Engram/b.md', { sections: [{ heading_path: [], index: -1, text: 'a', kind_hint: 'note' }] }), 'invalid:index'],
    ['an unknown section key', note('Engram/b.md', { sections: [{ heading_path: [], index: 0, text: 'a', kind_hint: 'note', level: 2 }] }), 'invalid:sections'],
    ['seven headings', note('Engram/b.md', { sections: [{ heading_path: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], index: 0, text: 'a', kind_hint: 'note' }] }), 'invalid:heading_path'],
    ['an mtime 10 minutes ahead', note('Engram/b.md', { mtime: TEN_MINUTES_AHEAD }), 'invalid:mtime'],
    ['a seen_at 10 minutes ahead', note('Engram/b.md', { seen_at: TEN_MINUTES_AHEAD }), 'invalid:seen_at'],
    ['a seen_at without an offset', note('Engram/b.md', { seen_at: '2026-10-06T11:00:00' }), 'invalid:seen_at'],
    ['a frontmatter array', note('Engram/b.md', { frontmatter: ['x'] }), 'invalid:frontmatter'],
    ['a frontmatter over 16,000 chars', note('Engram/b.md', { frontmatter: { body: 'x'.repeat(16_000) } }), 'invalid:frontmatter'],
  ])('rejects %s and still applies the other note', async (_name, bad, reason) => {
    const d = deps()
    const res = await runDocumentsRequest(d, body(bad, note('Engram/good.md')))
    expect(res.status).toBe(200)
    const accepted = res.body as DocumentsAccepted
    expect(accepted.results[0]).toEqual({ path: bad.path, status: 'rejected', reason })
    expect(accepted.results[1]).toMatchObject({ path: 'Engram/good.md', status: 'applied' })
    expect(d.syncDocumentNote).toHaveBeenCalledTimes(1)
  })

  it.each(['Tickets/ACME-1.md', 'Engram/Rulings.md', 'Aithentic/tickets/hub.md', 'Engram/RULINGS.md'])(
    'answers %s rejected excluded',
    async (path) => {
      const d = deps()
      const res = await runDocumentsRequest(d, body(note(path)))
      expect((res.body as DocumentsAccepted).results).toEqual([{ path, status: 'rejected', reason: 'excluded' }])
      expect(d.syncDocumentNote).not.toHaveBeenCalled()
    },
  )

  it('replaces U+0000 and unpaired surrogates before any rule, so the note is stored', async () => {
    const d = deps()
    await runDocumentsRequest(d, body(note('Engram/c.md', {
      sections: [{ heading_path: ['Head\u0000'], index: 0, text: 'bad \ud800 text', kind_hint: 'note' }],
    })))
    const section = sent(d).sections[0]!
    expect(section.headingPath).toEqual(['Head�'])
    expect(section.text).toBe('bad � text')
  })
})

describe('runDocumentsRequest: mapping', () => {
  it('maps a plan phase note to project engram, plan demo-plan and its sections', async () => {
    const d = deps()
    await runDocumentsRequest(d, body(note('Engram/Plans/Active/demo-plan/02-x.md', {
      sections: [
        { heading_path: [], index: 0, text: 'Intro.', kind_hint: 'plan_phase' },
        { heading_path: ['Tasks', 'Notes'], index: 2, text: 'First.', kind_hint: 'plan_phase' },
        { heading_path: ['Tasks', 'Notes'], index: 5, text: 'Second.', kind_hint: 'plan_phase' },
      ],
    })))
    const write = sent(d)
    expect(write).toMatchObject({
      path: 'Engram/Plans/Active/demo-plan/02-x.md',
      noteVersion: 'v-1',
      deleted: false,
      projectId: 'engram',
      workspaceId: 'ws-home',
      planSlug: 'demo-plan',
      frontmatter: { tags: ['plan'] },
    })
    expect(write.seenAt.toISOString()).toBe('2026-10-06T11:00:00.000Z')
    expect(write.mtime.toISOString()).toBe('2026-10-06T08:30:00.000Z')
    expect(write.sections.map((s) => [s.headingPath, s.ordinal, s.index, s.kind])).toEqual([
      [[], 0, 0, 'plan_phase'],
      [['Tasks', 'Notes'], 0, 2, 'plan_phase'],
      [['Tasks', 'Notes'], 1, 5, 'plan_phase'],
    ])
    expect(write.sections.map((s) => s.searchText)).toEqual([
      'Engram/Plans/Active/demo-plan/02-x.md: Intro.',
      'Engram/Plans/Active/demo-plan/02-x.md > Tasks > Notes: First.',
      'Engram/Plans/Active/demo-plan/02-x.md > Tasks > Notes: Second.',
    ])
  })

  it('gives a note under a folder two projects share the workspace only, and a root note neither', () => {
    expect(resolveNoteScope(REGISTRY, ['Aithentic', 'Notes', 'call.md'])).toEqual({ projectId: null, workspaceId: 'ws-acme' })
    expect(resolveNoteScope(REGISTRY, ['Home', 'todo.md'])).toEqual({ projectId: null, workspaceId: 'ws-home' })
    expect(resolveNoteScope(REGISTRY, ['inbox.md'])).toEqual({ projectId: null, workspaceId: null })
    expect(resolveNoteScope(REGISTRY, ['Unfiled', 'x.md'])).toEqual({ projectId: null, workspaceId: null })
  })

  it('reads plan_slug from a plan folder or a single-doc plan, and nothing else', () => {
    expect(planSlugOf(['Engram', 'Plans', 'Delivered', 'demo-plan.md'])).toBe('demo-plan')
    expect(planSlugOf(['Engram', 'Plans', 'Design Records', 'demo-plan', 'README.md'])).toBe('demo-plan')
    expect(planSlugOf(['Engram', 'Plans', 'Plans.md'])).toBeNull()
    expect(planSlugOf(['Engram', 'Plans', 'Archive', 'demo-plan', 'a.md'])).toBeNull()
    expect(planSlugOf(['Engram', 'Notes', 'Active', 'demo-plan', 'a.md'])).toBeNull()
    expect(planSlugOf(['Engram', 'Plans', 'Active', 'Demo Plan', 'a.md'])).toBeNull()
  })

  it('scrubs text, headings and frontmatter strings and names each hit by item field', async () => {
    const scrub = async (text: string): Promise<ScrubResult> =>
      text.includes('hunter2')
        ? { text: text.replaceAll('hunter2', '[REDACTED]'), redactions: [{ kind: 'known', name: 'DB_PASSWORD' }] }
        : { text, redactions: [] }
    const d = deps({ scrub })
    await runDocumentsRequest(d, body(note('Engram/d.md', {
      frontmatter: { db: { password: 'hunter2' } },
      sections: [{ heading_path: ['Login hunter2'], index: 0, text: 'pw hunter2', kind_hint: 'note' }],
    })))
    const write = sent(d)
    expect(write.frontmatter).toEqual({ db: { password: '[REDACTED]' } })
    expect(write.sections[0]).toMatchObject({
      headingPath: ['Login [REDACTED]'],
      text: 'pw [REDACTED]',
      searchText: 'Engram/d.md > Login [REDACTED]: pw [REDACTED]',
      hits: [
        { field: 'source.heading_path[0]', detector: 'known', secretName: 'DB_PASSWORD' },
        { field: 'content', detector: 'known', secretName: 'DB_PASSWORD' },
      ],
    })
  })

  it('sends a deleted note with no sections and a null frontmatter', async () => {
    const d = deps()
    await runDocumentsRequest(d, body(note('Engram/e.md', { deleted: true, sections: [], frontmatter: null })))
    expect(sent(d)).toMatchObject({ deleted: true, sections: [], frontmatter: null })
  })
})

describe('runDocumentsRequest: store outcomes', () => {
  it("marks one note failed on its store error, applies the others, and logs no path", async () => {
    const d = deps()
    d.syncDocumentNote.mockImplementation(async (n: DocumentNoteWrite) => {
      if (n.path === 'Engram/broken.md') throw Object.assign(new Error('deadlock on Engram/broken.md'), { code: '40P01' })
      return APPLIED
    })
    const res = await runDocumentsRequest(d, body(note('Engram/one.md'), note('Engram/broken.md'), note('Engram/two.md')))
    expect(res.status).toBe(200)
    const accepted = res.body as DocumentsAccepted
    expect(accepted.results.map((r) => r.status)).toEqual(['applied', 'failed', 'applied'])
    expect(accepted.results[1]).toEqual({ path: 'Engram/broken.md', status: 'failed' })
    const logged = JSON.stringify(d.log.mock.calls)
    expect(logged).toContain('40P01')
    expect(logged).not.toContain('broken')
    expect(logged).not.toContain('Ship the worker')
  })

  it('answers 500, retryable, when every note that ran failed', async () => {
    const d = deps()
    d.syncDocumentNote.mockRejectedValue(new Error('connection refused'))
    const res = await runDocumentsRequest(d, body(note('Engram/one.md'), note('/abs.md')))
    expect(res).toEqual({ status: 500, body: { error: DOCUMENTS_FAILED_MESSAGE, retryable: true } })
  })

  it('answers 200 when every note was rejected, since none could run', async () => {
    const d = deps()
    const res = await runDocumentsRequest(d, body(note('/abs.md')))
    expect(res.status).toBe(200)
  })

  it('adds up the totals across statuses and section counts', async () => {
    const d = deps()
    const results: DocumentNoteSyncResult[] = [
      APPLIED,
      { status: 'unchanged', sections: null, itemIds: [] },
      { status: 'stale', sections: null, itemIds: [] },
      APPLIED,
    ]
    d.syncDocumentNote.mockImplementation(async () => results.shift()!)
    const res = await runDocumentsRequest(d, body(
      note('Engram/1.md'), note('Engram/2.md'), note('Engram/3.md'), note('Engram/4.md'), note('Tickets/t.md'),
    ))
    const accepted = res.body as DocumentsAccepted
    expect(accepted.results[0]!.sections).toEqual({
      created: 2, superseded: 1, unchanged: 0, retired: 1, restored: 1, kept_forgotten: 0, kept_retired: 0, skipped_empty: 0,
    })
    expect(accepted.results[1]).toEqual({ path: 'Engram/2.md', status: 'unchanged' })
    expect(accepted.totals).toEqual({
      notes: 5, applied: 2, unchanged: 1, stale: 1, rejected: 1, failed: 0,
      created: 4, superseded: 2, retired: 2, restored: 2,
    })
    const statusSum = accepted.totals.applied + accepted.totals.unchanged + accepted.totals.stale +
      accepted.totals.rejected + accepted.totals.failed
    expect(statusSum).toBe(accepted.totals.notes)
  })
})
