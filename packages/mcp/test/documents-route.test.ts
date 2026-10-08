/**
 * POST /documents/sync below HTTP: request rules (400), per-note rules
 * (`rejected invalid:<field>`, `excluded`), the mapping from a vault note to
 * its scope, plan and sections, per-note store failures, and the totals.
 */

import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SECRET_SOURCES_ENV,
  resetDefaultSecretRegistry,
  scrubSecrets,
  type DocumentNoteSyncResult,
  type DocumentNoteWrite,
  type ScrubResult,
} from '@engram-mem/core'
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

  it('gives a note under a folder several projects share with no workspace the project named like the folder', () => {
    const shared = parseProjectRegistry({
      version: 1,
      workspaces: {},
      projects: {
        'tst-zeta': { workspace: null, vault_folder: 'Sampleset', register_prefix: 'TSTS' },
        sampleset: { workspace: null, vault_folder: 'Sampleset', register_prefix: 'TSTS' },
        'tst-alpha': { workspace: null, vault_folder: 'Sampleset', register_prefix: 'TSTS' },
      },
    })
    expect(resolveNoteScope(shared, ['Sampleset', 'Plans', 'Active', 'demo-plan', 'LEDGER.md'])).toEqual({
      projectId: 'sampleset',
      workspaceId: null,
    })
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
      frontmatter: { db: { note: 'hunter2' } },
      sections: [{ heading_path: ['Login hunter2'], index: 0, text: 'pw hunter2', kind_hint: 'note' }],
    })))
    const write = sent(d)
    expect(write.frontmatter).toEqual({ db: { note: '[REDACTED]' } })
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

// Made-up values; none is a real credential.
const FM_PASSWORD = 'Zq7-made-up-not-real-91x'
const FM_BEARER = 'Bearer Zq7madeupNotReal91xAbc'
const FM_TOKEN = 'Zq7madeupTokenNotReal91xQw'
const FM_REGISTERED = 'Kd4madeupRegisteredValue73pX'

const FM_MIXED = 'Q7xk2Lm9Vp4Rt8Wz'
const FM_OAUTH = 'sk-ant-oat01-' + FM_MIXED.repeat(4)

describe('runDocumentsRequest: frontmatter passes every scrub view', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'engram-documents-registry-'))
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ DEPLOY_SECRET: FM_REGISTERED }))
    writeFileSync(join(dir, 'sources.json'), JSON.stringify({ sources: [{ path: 'secrets.json', format: 'json-keys' }] }))
    vi.stubEnv(SECRET_SOURCES_ENV, join(dir, 'sources.json'))
    resetDefaultSecretRegistry()
  })
  afterAll(() => {
    vi.unstubAllEnvs()
    resetDefaultSecretRegistry()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([
    ['a credential-named key', { db_password: FM_PASSWORD }, { db_password: '[REDACTED:db_password]' }],
    ['an Authorization header', { Authorization: FM_BEARER }, { Authorization: '[REDACTED:Authorization]' }],
    ['a nested credential key', { deploy: { api_token: FM_TOKEN } }, { deploy: { api_token: '[REDACTED:api_token]' } }],
    [
      'a credential key inside an array of objects',
      { servers: [{ host: 'db.local', password: FM_PASSWORD }] },
      { servers: [{ host: 'db.local', password: '[REDACTED:password]' }] },
    ],
    ['a registered value used as a key', { [FM_REGISTERED]: 'note' }, { '[REDACTED:DEPLOY_SECRET]': 'note' }],
    ['a number under a credential key', { session: 3 }, { session: '[REDACTED:session]' }],
    ['a plain key and value', { title: 'Release notes', tags: ['plan'] }, { title: 'Release notes', tags: ['plan'] }],
  ])('sends the store %s masked', async (_name, frontmatter, expected) => {
    const d = deps({ scrub: scrubSecrets })
    const out = await runDocumentsRequest(d, body(note('Engram/f.md', { frontmatter })))
    expect(out.status).toBe(200)
    expect((out.body as DocumentsAccepted).results[0]).toMatchObject({ path: 'Engram/f.md', status: 'applied' })
    expect(sent(d).frontmatter).toEqual(expected)
  })

  it('scrubs each frontmatter string on its own text, so a token at a line start inside a value is masked', async () => {
    const notes = `deploy steps\n${FM_OAUTH}`
    const d = deps({ scrub: scrubSecrets })
    await runDocumentsRequest(d, body(note('Engram/f.md', { frontmatter: { notes } })))
    expect(sent(d).frontmatter).toEqual({ notes: (await scrubSecrets(notes)).text })
    expect(JSON.stringify(sent(d))).not.toContain(FM_OAUTH)
  })

  it('rejects a note whose frontmatter holds a secret only the whole-text pass finds, and still applies the others', async () => {
    const d = deps({ scrub: scrubSecrets })
    const out = await runDocumentsRequest(d, body(
      note('Engram/t.md', { frontmatter: { headers: [['Authorization', FM_BEARER]] } }),
      note('Engram/u.md', { frontmatter: { title: 'Release notes' } }),
    ))
    expect(out.status).toBe(200)
    const accepted = out.body as DocumentsAccepted
    expect(accepted.results[0]).toEqual({ path: 'Engram/t.md', status: 'rejected', reason: 'invalid:frontmatter' })
    expect(accepted.results[1]).toMatchObject({ path: 'Engram/u.md', status: 'applied' })
    expect(d.syncDocumentNote).toHaveBeenCalledTimes(1)
    expect(sent(d)).toMatchObject({ path: 'Engram/u.md', frontmatter: { title: 'Release notes' } })
    expect(JSON.stringify(d.syncDocumentNote.mock.calls)).not.toContain(FM_BEARER.slice('Bearer '.length))
  })

  it('rejects a note whose frontmatter keys mask into one, stores none of it, and still applies the others', async () => {
    const d = deps({ scrub: scrubSecrets })
    const out = await runDocumentsRequest(d, body(
      note('Engram/g.md', { frontmatter: { [FM_REGISTERED]: 'a', '[REDACTED:DEPLOY_SECRET]': 'b', db_password: FM_PASSWORD } }),
      note('Engram/h.md'),
    ))
    expect(out.status).toBe(200)
    const accepted = out.body as DocumentsAccepted
    expect(accepted.results[0]).toEqual({ path: 'Engram/g.md', status: 'rejected', reason: 'invalid:frontmatter' })
    expect(accepted.results[1]).toMatchObject({ path: 'Engram/h.md', status: 'applied' })
    expect(d.syncDocumentNote).toHaveBeenCalledTimes(1)
    expect(sent(d).path).toBe('Engram/h.md')
    const calls = JSON.stringify(d.syncDocumentNote.mock.calls)
    expect(calls).not.toContain(FM_PASSWORD)
    expect(calls).not.toContain(FM_REGISTERED)
  })
})
