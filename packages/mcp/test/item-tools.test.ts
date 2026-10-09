/**
 * memory_ingest's typed input: an observation is gated for attribution and
 * its evidence verified for trust; MK's words must be found in his captured
 * utterances for the session; links follow the link rules; the write's
 * answer names the stored, restated or duplicate item. A fake item store
 * covers the rules, and one real Postgres case covers the store reads, the
 * write and the item invariants.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  generateId,
  labelKey,
  normalizeQuote,
  resetDefaultSecretRegistry,
  type ExtractionCommitResult,
  type IngestItemWrite,
  type IngestProject,
  type ItemIngestStore,
  type LinkTarget,
  type RawWindowUtterance,
  type SecretRegistryStatus,
  type StoredEvent,
} from '@engram-mem/core'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { UNTYPED_INGEST_MESSAGE, runMemoryIngestTyped, type ItemToolDeps } from '../src/item-tools.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from '../../postgrest/test/real-pg/harness.js'

const TOKEN = ('c4' + randomBytes(24).toString('hex')).slice(0, 40)
const SESSION = 'sess-tool-k8w'
const OTHER_SESSION = 'sess-tool-m2v'
const HEALTHY: SecretRegistryStatus = { configured: true, unreadable: [], values: 1 }
const PROJECTS: IngestProject[] = [
  { id: 'tst-ws', kind: 'workspace', workspaceId: null },
  { id: 'tst-repo', kind: 'project', workspaceId: 'tst-ws' },
]

interface FakeItem {
  id: string
  class: string
  kind: string
  speaker: string
  session_id: string | null
  project_id: string | null
  workspace_id: string | null
  subject_id: string | null
  content: string
  context: string | null
  occurred_at: string
  source: Record<string, unknown>
  trust: number
  lineage: string[]
  superseded_by: string | null
  forgotten_at: string | null
  restated_at: string[]
}

/** The store's reads over an in-memory table, and a write that applies identity, restatement and supersession. */
class FakeItemStore implements ItemIngestStore {
  items: FakeItem[] = []
  subjects: Array<{ id: string; projectId: string | null; label: string }> = []
  payloads = new Map<string, unknown>()
  writes: IngestItemWrite[] = []

  add(over: Partial<FakeItem> & Pick<FakeItem, 'class' | 'kind' | 'content'>): FakeItem {
    const item: FakeItem = {
      id: generateId(),
      speaker: over.class === 'utterance' && over.kind !== 'assistant_turn' ? 'mk' : 'assistant',
      session_id: SESSION,
      project_id: 'tst-repo',
      workspace_id: 'tst-ws',
      subject_id: null,
      context: null,
      occurred_at: '2026-10-01T10:00:00.000Z',
      source: {},
      trust: 0,
      lineage: [],
      superseded_by: null,
      forgotten_at: null,
      restated_at: [],
      ...over,
    }
    this.items.push(item)
    return item
  }

  subject(label: string, projectId: string | null = 'tst-repo'): string {
    const id = generateId()
    this.subjects.push({ id, projectId, label })
    return id
  }

  async sessionMkUtterances(sessionId: string): Promise<RawWindowUtterance[]> {
    return this.items
      .filter((i) => i.session_id === sessionId && i.speaker === 'mk' && i.class === 'utterance')
      .filter((i) => i.superseded_by === null && i.forgotten_at === null)
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || a.id.localeCompare(b.id))
      .map(toRow)
  }

  async assistantTurnBefore(u: Pick<RawWindowUtterance, 'id' | 'session_id' | 'occurred_at'>): Promise<RawWindowUtterance | null> {
    const before = this.items
      .filter((i) => i.kind === 'assistant_turn' && i.session_id === u.session_id && i.forgotten_at === null)
      .filter((i) => i.occurred_at < u.occurred_at || (i.occurred_at === u.occurred_at && i.id < u.id))
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id.localeCompare(a.id))
    return before[0] === undefined ? null : toRow(before[0])
  }

  async captureEventPayload(eventId: string): Promise<unknown> {
    return this.payloads.get(eventId) ?? null
  }

  async projectRows(): Promise<IngestProject[]> {
    return PROJECTS
  }

  async subjectIdByLabel(projectId: string | null, label: string): Promise<string | null> {
    return this.subjects.find((s) => s.projectId === projectId && labelKey(s.label) === labelKey(label))?.id ?? null
  }

  async linkTargets(ids: readonly string[]): Promise<LinkTarget[]> {
    return this.items
      .filter((i) => ids.includes(i.id))
      .map((i) => ({
        id: i.id,
        class: i.class,
        kind: i.kind,
        subjectId: i.subject_id,
        subjectLabel: this.subjects.find((s) => s.id === i.subject_id)?.label ?? null,
        occurredAt: i.occurred_at,
        supersededBy: i.superseded_by,
        retiredAt: null,
        forgottenAt: i.forgotten_at,
        projectId: i.project_id,
        workspaceId: i.workspace_id,
        shown: false,
      }))
  }

  async commitArtifactIds(prefix: string): Promise<string[]> {
    return this.items
      .filter((i) => i.class === 'artifact' && i.kind === 'commit' && String(i.source['sha']).startsWith(prefix.toLowerCase()))
      .map((i) => i.id)
  }

  async ingestItem(write: IngestItemWrite): Promise<ExtractionCommitResult> {
    this.writes.push(write)
    const item = write.item
    const stored = this.items.find((i) => i.source['event_key'] === item.source['event_key'])
    if (stored) return result(stored.id, { duplicates: 1 })
    let subjectId = item.subjectId
    let subjectsCreated = 0
    if (subjectId === null) {
      const fresh = write.subjects[0]!
      subjectId = (await this.subjectIdByLabel(fresh.projectId, fresh.label)) ?? this.subject(fresh.label, fresh.projectId)
      subjectsCreated = 1
    }
    const repeat = this.items.find(
      (i) =>
        i.class === item.class &&
        i.subject_id === subjectId &&
        i.superseded_by === null &&
        i.forgotten_at === null &&
        normalizeQuote(i.content) === normalizeQuote(item.content),
    )
    if (repeat) {
      repeat.restated_at.push(item.occurredAt.toISOString())
      return result(repeat.id, { restatements: 1, subjectsCreated })
    }
    this.items.push({
      id: item.id,
      class: item.class,
      kind: item.kind,
      speaker: item.speaker,
      session_id: item.sessionId,
      project_id: item.projectId,
      workspace_id: item.workspaceId,
      subject_id: subjectId,
      content: item.content,
      context: item.context,
      occurred_at: item.occurredAt.toISOString(),
      source: { ...item.source },
      trust: item.trust,
      lineage: [...item.lineage],
      superseded_by: null,
      forgotten_at: null,
      restated_at: [],
    })
    for (const link of item.links ?? []) {
      if (link.rel === 'supersedes') this.items.find((i) => i.id === link.target)!.superseded_by = item.id
    }
    return result(item.id, { subjectsCreated })
  }

  stored(id: string): FakeItem {
    return this.items.find((i) => i.id === id)!
  }
}

function toRow(i: FakeItem): RawWindowUtterance {
  return {
    id: i.id,
    kind: i.kind as RawWindowUtterance['kind'],
    session_id: i.session_id,
    project_id: i.project_id,
    workspace_id: i.workspace_id,
    content: i.content,
    context: i.context,
    occurred_at: i.occurred_at,
    source: i.source,
  }
}

function result(id: string, counts: Partial<ExtractionCommitResult>): ExtractionCommitResult {
  return { itemIds: [id], subjectsCreated: 0, duplicates: 0, restatements: 0, ...counts }
}

function answer(res: { content: Array<{ text: string }>; isError?: true }): { id: string; outcome: string } {
  expect(res.isError).toBeUndefined()
  return JSON.parse(res.content[0]!.text) as { id: string; outcome: string }
}

function errorText(res: { content: Array<{ text: string }>; isError?: true }): string {
  expect(res.isError).toBe(true)
  return res.content[0]!.text
}

beforeEach(() => {
  vi.stubEnv('ENGRAM_SECRET_SOURCES_FILE', '')
  vi.stubEnv('ENGRAM_CAPTURE_TOKEN', TOKEN)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetDefaultSecretRegistry()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetDefaultSecretRegistry()
})

describe('memory_ingest with typed input', () => {
  let store: FakeItemStore
  let deps: ItemToolDeps

  beforeEach(() => {
    store = new FakeItemStore()
    deps = { store, status: () => HEALTHY, now: () => new Date('2026-10-02T09:00:00.000Z') }
  })

  function said(content: string, over: Partial<FakeItem> = {}): FakeItem {
    return store.add({ class: 'utterance', kind: 'user_prompt', content, ...over })
  }

  const observation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    class: 'observation',
    kind: 'finding',
    subject: 'storage engine',
    content: 'The item store runs on Postgres 17.',
    evidence: [{ type: 'file', ref: 'packages/postgrest/schema.sql' }],
    project_id: 'tst-repo',
    session_id: SESSION,
    ...over,
  })

  const statement = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    class: 'mk_statement',
    kind: 'ruling',
    subject: 'storage engine',
    quote: 'Postgres only',
    session_id: SESSION,
    ...over,
  })

  it('answers the untyped form with the typed forms and writes nothing', async () => {
    const res = await runMemoryIngestTyped(deps, { content: 'Prefer squash merges', role: 'user' })

    expect(res).toEqual({ content: [{ type: 'text', text: UNTYPED_INGEST_MESSAGE }], isError: true })
    expect(store.writes).toHaveLength(0)
  })

  it('stores an observation whose item evidence resolves at trust 2 with that item as lineage', async () => {
    const cited = store.add({ class: 'mk_statement', kind: 'fact', content: 'The store is Postgres.' })

    const { id, outcome } = answer(await runMemoryIngestTyped(deps, observation({ evidence: [{ type: 'item', ref: cited.id }] })))

    expect(outcome).toBe('stored')
    expect(store.stored(id)).toMatchObject({ trust: 2, lineage: [cited.id], speaker: 'assistant', project_id: 'tst-repo' })
  })

  it('stores an observation with only file evidence at trust 3 with no lineage', async () => {
    const { id } = answer(await runMemoryIngestTyped(deps, observation()))

    expect(store.stored(id)).toMatchObject({ trust: 3, lineage: [] })
    expect(store.stored(id).source).toMatchObject({ type: 'ingest_tool', evidence: [{ type: 'file', ref: 'packages/postgrest/schema.sql' }] })
  })

  it('refuses an observation that puts a decision in MK\'s mouth', async () => {
    const res = await runMemoryIngestTyped(deps, observation({ content: 'MK decided to drop SQLite' }))

    expect(errorText(res)).toMatch(/attributes a decision or wish to MK/)
    expect(store.writes).toHaveLength(0)
  })

  it("stores MK's words found under the quote rule with the utterance's lineage and project", async () => {
    const utterance = said('we use  Postgres only now')

    const { id, outcome } = answer(await runMemoryIngestTyped(deps, statement()))

    expect(outcome).toBe('stored')
    expect(store.stored(id)).toMatchObject({
      trust: 0,
      speaker: 'mk',
      content: 'Postgres only',
      lineage: [utterance.id],
      project_id: 'tst-repo',
      workspace_id: 'tst-ws',
      occurred_at: utterance.occurred_at,
    })
    expect(store.writes[0]!.item.source).toEqual({
      type: 'ingest_tool',
      utterance_id: utterance.id,
      event_key: expect.stringMatching(new RegExp(`^mk_statement:${utterance.id}:[0-9a-f]{64}$`)),
    })
  })

  it("refuses a quote MK said in another session with the capture message", async () => {
    said('we use Postgres only now', { session_id: OTHER_SESSION })

    const res = await runMemoryIngestTyped(deps, statement())

    expect(errorText(res)).toBe(
      `Error: quote not found in MK's captured words for session ${SESSION}. A turn is captured when it ends: ` +
        'quote words from an earlier turn, exactly as MK wrote them.',
    )
    expect(store.writes).toHaveLength(0)
  })

  it('keeps a question found in the assistant turn before the words and refuses a reworded one', async () => {
    store.add({ class: 'utterance', kind: 'assistant_turn', content: 'Should the store keep SQLite as a fallback?', occurred_at: '2026-10-01T09:59:00.000Z' })
    said('no, Postgres only')

    const refused = await runMemoryIngestTyped(deps, statement({ question: 'Do we keep SQLite?' }))
    const kept = answer(await runMemoryIngestTyped(deps, statement({ question: 'keep SQLite as a fallback?' })))

    expect(errorText(refused)).toMatch(/^Error: question not found/)
    expect(store.stored(kept.id).context).toBe('keep SQLite as a fallback?')
  })

  it('matches a quote holding a registered secret against the masked utterance and stores it masked', async () => {
    said('the hook sends [REDACTED:ENGRAM_CAPTURE_TOKEN] as its bearer')

    const { id } = answer(await runMemoryIngestTyped(deps, statement({ quote: `sends ${TOKEN} as its bearer` })))

    expect(store.stored(id).content).toBe('sends [REDACTED:ENGRAM_CAPTURE_TOKEN] as its bearer')
    expect(JSON.stringify(store.writes)).not.toContain(TOKEN)
  })

  it('answers the same call twice as a duplicate of the first item', async () => {
    said('we use Postgres only now')

    const first = answer(await runMemoryIngestTyped(deps, statement()))
    const second = answer(await runMemoryIngestTyped(deps, statement()))

    expect(second).toEqual({ id: first.id, outcome: 'duplicate' })
  })

  it('restates a current statement holding the same words on the subject', async () => {
    const subjectId = store.subject('storage engine')
    const current = store.add({ class: 'mk_statement', kind: 'ruling', content: 'Postgres only', subject_id: subjectId, source: { event_key: 'mk_statement:older' } })
    said('as I said, Postgres only', { occurred_at: '2026-10-03T10:00:00.000Z' })

    const res = answer(await runMemoryIngestTyped(deps, statement()))

    expect(res).toEqual({ id: current.id, outcome: 'restated' })
    expect(store.stored(current.id).restated_at).toEqual(['2026-10-03T10:00:00.000Z'])
  })

  it('refuses a supersedes target filed under another subject', async () => {
    const other = store.add({ class: 'mk_statement', kind: 'ruling', content: 'Deploy on Fridays', subject_id: store.subject('deploy window') })
    said('we use Postgres only now', { occurred_at: '2026-10-03T10:00:00.000Z' })

    const res = await runMemoryIngestTyped(deps, statement({ supersedes: [other.id] }))

    expect(errorText(res)).toBe(`Error: supersedes ${other.id} refused: subject_mismatch`)
    expect(store.writes).toHaveLength(0)
  })

  it('refuses a project_id the registry does not hold', async () => {
    const res = await runMemoryIngestTyped(deps, observation({ project_id: 'tst-unknown' }))

    expect(errorText(res)).toBe('Error: project_id tst-unknown is not a registered project')
    expect(store.writes).toHaveLength(0)
  })

  it('stores an observation without session_id with no session, never a default one', async () => {
    const { id } = answer(await runMemoryIngestTyped(deps, observation({ session_id: undefined })))

    expect(store.stored(id).session_id).toBeNull()
    expect(String(store.stored(id).source['event_key'])).toMatch(/^observation:ingest:none:[0-9a-f]{64}$/)
  })

  it('refuses while the secret registry is degraded and writes nothing', async () => {
    said('we use Postgres only now')
    deps = { ...deps, status: () => ({ configured: true, unreadable: ['/run/secrets/engram.env'], values: 0 }) }

    const res = await runMemoryIngestTyped(deps, statement())

    expect(errorText(res)).toMatch(/secret registry is degraded/)
    expect(store.writes).toHaveLength(0)
  })

  it('refuses fields the class does not take', async () => {
    expect(errorText(await runMemoryIngestTyped(deps, observation({ quote: 'x' })))).toBe(
      'Error: quote is not accepted for class observation',
    )
    expect(errorText(await runMemoryIngestTyped(deps, statement({ role: 'user' })))).toBe('Error: unknown field: role')
  })
})

let eventCounter = 0
function storedEvent(type: StoredEvent['type'], payload: Record<string, unknown>, occurredAt: string): StoredEvent {
  eventCounter += 1
  return {
    sessionId: SESSION,
    eventUuid: `tool-evt-${eventCounter}`,
    type,
    occurredAt,
    cwd: '/home/tester/tst-repo',
    project: { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null },
    planDirs: [],
    client: { name: 'engram-test', version: '1.0.0' },
    payload,
    scrub: { masked: [] },
    hits: [],
  }
}

describe.skipIf(!realPgImage || !postgrestImage)('memory_ingest on real Postgres behind PostgREST', () => {
  const SHA = '7c3e9a1f0b2d4c6e8a0b1c2d3e4f5a6b7c8d9e0f'
  let pg: RealPg
  let store: PostgRestCaptureStore

  beforeAll(async () => {
    pg = await startRealPg({ withPostgrest: true })
    await pg.applySchema()
    const endpoint = await pg.startPostgrest()
    store = new PostgRestCaptureStore({ url: endpoint.url, key: endpoint.serviceJwt })
    await store.syncProjects([
      { id: 'tst-ws', kind: 'workspace', workspaceId: null, vaultFolder: null, registerPrefix: null },
      { id: 'tst-repo', kind: 'project', workspaceId: 'tst-ws', vaultFolder: null, registerPrefix: null },
    ])
  }, 120_000)

  afterAll(async () => {
    await pg?.stop()
  }, 60_000)

  it('stores a statement and an observation citing it and a commit, and every invariant holds', async () => {
    const events = [
      storedEvent('assistant_turn', { text: 'Should the store keep SQLite as a fallback?', transcript_line: 1, tools: [] }, '2026-10-01T09:59:00.000Z'),
      storedEvent('user_prompt', { text: 'no, we use  Postgres only now', transcript_line: 2 }, '2026-10-01T10:00:00.000Z'),
      storedEvent('git_commit', { repo: 'tst-repo', sha: SHA, message: 'feat: drop the SQLite fallback', files: ['src/store.ts'], authored_at: '2026-10-01T10:05:00Z' }, '2026-10-01T10:05:00.000Z'),
    ]
    expect((await store.ingestEvents(events)).map((e) => e.status)).toEqual(['accepted', 'accepted', 'accepted'])
    expect(await store.materialize(1000)).toMatchObject({ locked: true, failed: 0 })
    const deps: ItemToolDeps = { store, status: () => HEALTHY }

    const said = answer(
      await runMemoryIngestTyped(deps, {
        class: 'mk_statement',
        kind: 'ruling',
        subject: 'storage engine',
        quote: 'Postgres only',
        question: 'keep SQLite as a fallback?',
        session_id: SESSION,
      }),
    )
    const again = answer(
      await runMemoryIngestTyped(deps, {
        class: 'mk_statement',
        kind: 'ruling',
        subject: 'storage engine',
        quote: 'Postgres only',
        question: 'keep SQLite as a fallback?',
        session_id: SESSION,
      }),
    )
    const seen = answer(
      await runMemoryIngestTyped(deps, {
        class: 'observation',
        kind: 'finding',
        subject: 'Storage  Engine',
        content: 'The SQLite fallback is gone from the store.',
        evidence: [
          { type: 'item', ref: said.id },
          { type: 'commit', ref: SHA.slice(0, 9).toUpperCase() },
        ],
        project_id: 'tst-repo',
      }),
    )

    expect(said.outcome).toBe('stored')
    expect(again).toEqual({ id: said.id, outcome: 'duplicate' })
    const artifact = await pg.psql(`SELECT id FROM public.memory_items WHERE class = 'artifact' AND kind = 'commit';`)
    const row = await pg.psql(
      `SELECT trust || ' ' || array_to_string(lineage, ',') || ' ' || (session_id IS NULL) || ' ' || ` +
        `(subject_id = (SELECT subject_id FROM public.memory_items WHERE id = '${said.id}')) ` +
        `FROM public.memory_items WHERE id = '${seen.id}';`,
    )
    expect(row).toBe(`2 ${said.id},${artifact} true true`)
    expect(await pg.psql(`SELECT context FROM public.memory_items WHERE id = '${said.id}';`)).toBe('keep SQLite as a fallback?')
    expect(await pg.psql('SELECT coalesce(sum(violations), 0) FROM public.engram_invariant_counts();')).toBe('0')
  }, 60_000)
})
