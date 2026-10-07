/**
 * engram-extract against real Postgres behind a real PostgREST, after the
 * extractor version went up: a version bump re-extracts nothing by itself.
 * - A gap fill takes only the windows no version extracted, as the worker
 *   does, so a window an earlier version extracted is skipped.
 * - --replace re-runs that window at this version, retires the earlier
 *   version's item the new run does not reproduce, and makes the session due
 *   for a new index even when the new run stores nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  EXTRACTOR_VERSION,
  generateId,
  itemEventKey,
  type ExtractionItem,
  type IntelligenceAdapter,
  type StoredEvent,
} from '@engram-mem/core'
import { PostgRestCaptureStore } from '@engram-mem/postgrest'
import { EXIT_OK, runExtract, type ExtractOptions } from '../src/ingest/extract-lib.js'
import { postgrestImage, realPgImage, startRealPg, type RealPg } from '../../postgrest/test/real-pg/harness.js'

const SETUP_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 60_000
const SESSION = 'tst-extract-bump'
const OLD = 'tst-extractor-old'
const REPO = { id: 'tst-repo', workspace: 'tst-ws', repo_root: '/home/tester/tst-repo', branch: 'main', worktree: null }

let eventCounter = 0
function event(type: string, payload: Record<string, unknown>, occurredAt: string): StoredEvent {
  eventCounter += 1
  return {
    sessionId: SESSION,
    eventUuid: `extract-bump-evt-${eventCounter}`,
    type,
    occurredAt,
    cwd: '/home/tester/tst-repo',
    project: { ...REPO },
    planDirs: [],
    client: { name: 'engram-test', version: '1.0.0' },
    payload,
    scrub: { masked: [] },
    hits: [],
  }
}

/** A model that finds nothing in any window. */
function emptyModel(): { intelligence: IntelligenceAdapter; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    intelligence: {
      async completeJson() {
        calls += 1
        return { text: JSON.stringify({ statements: [], observations: [] }), finishReason: 'stop', model: 'tst-model' }
      },
    } as IntelligenceAdapter,
  }
}

describe.skipIf(!realPgImage || !postgrestImage)('engram-extract after an extractor version bump', () => {
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
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await pg?.stop()
  }, TEST_TIMEOUT_MS)

  beforeEach(async () => {
    await pg.psql(
      'TRUNCATE public.memory_item_links, public.memory_items, public.memory_capture_events, ' +
        'public.memory_extraction_runs, public.memory_subjects, public.memory_session_state CASCADE;',
    )
  })

  /**
   * One ended session whose prompt an earlier extractor version extracted
   * into one statement, with the session's index built after it. Returns the
   * prompt and the statement.
   */
  async function extractedEarlier(): Promise<{ prompt: string; statement: string }> {
    const said = 'keep the cache on sqlite'
    const events = [
      event('user_prompt', { text: said, transcript_line: 1 }, '2026-03-02T10:00:00Z'),
      event('session_end', {}, '2026-03-02T10:01:00Z'),
    ]
    const ingested = await store.ingestEvents(events)
    expect(ingested.map((e) => e.status)).toEqual(['accepted', 'accepted'])
    expect(await store.materialize(1000)).toMatchObject({ locked: true, failed: 0 })
    const prompt = await pg.psql(`SELECT id FROM public.memory_items WHERE source ->> 'event_id' = '${ingested[0]!.eventId}';`)
    const subject = await pg.psql(
      "WITH added AS (INSERT INTO public.memory_subjects (project_id, label) VALUES ('tst-repo', 'cache store') RETURNING id) SELECT id FROM added;",
    )
    const item: ExtractionItem = {
      id: generateId(),
      class: 'mk_statement',
      kind: 'ruling',
      speaker: 'mk',
      trust: 0,
      projectId: 'tst-repo',
      workspaceId: 'tst-ws',
      planSlug: null,
      sessionId: SESSION,
      subjectId: subject,
      subjectKey: null,
      content: said,
      searchText: said,
      context: null,
      occurredAt: new Date('2026-03-02T10:00:00Z'),
      standing: false,
      registerStatus: null,
      source: { type: 'extraction', utterance_id: prompt, event_key: itemEventKey('mk_statement', prompt, said), scope: 'project', applies_to: [] },
      lineage: [prompt],
      entities: [],
    }
    const run = await store.extractionBegin({ anchorId: prompt, sessionId: SESSION, version: OLD, model: null })
    expect(run).not.toBeNull()
    await store.extractionCommit(run!, { subjects: [], items: [item], stats: {} })
    await pg.psql(`UPDATE public.memory_session_state SET indexed_event_id = last_event_id WHERE session_id = '${SESSION}';`)
    return { prompt, statement: item.id }
  }

  async function extract(replace: boolean) {
    const model = emptyModel()
    const emitted: Record<string, unknown>[] = []
    const opts: ExtractOptions = { sessionId: SESSION, since: null, maxCalls: 5, version: null, dryRun: false, replace, reportPath: null }
    const outcome = await runExtract(opts, {
      store,
      intelligence: model.intelligence,
      model: 'tst-model',
      now: () => new Date(),
      emit: (s) => emitted.push(s),
      log: () => {},
      report: null,
    })
    return { outcome, emitted, calls: model.calls() }
  }

  const runsAtThisVersion = (): Promise<string> =>
    pg.psql(`SELECT count(*) FROM public.memory_extraction_runs WHERE extractor_version = '${EXTRACTOR_VERSION}';`)
  const indexDue = (): Promise<string> =>
    pg.psql(`SELECT indexed_event_id = 0 FROM public.memory_session_state WHERE session_id = '${SESSION}';`)

  it(
    'skips on a gap fill a window an earlier version extracted',
    async () => {
      const { statement } = await extractedEarlier()

      const { outcome, emitted, calls } = await extract(false)

      expect(outcome).toMatchObject({ exitCode: EXIT_OK, windows: 0, calls: 0 })
      expect(calls).toBe(0)
      expect(emitted).toEqual([])
      expect(await runsAtThisVersion()).toBe('0')
      expect(await pg.psql(`SELECT retired_at IS NULL FROM public.memory_items WHERE id = '${statement}';`)).toBe('t')
      expect(await indexDue()).toBe('f')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    're-runs that window on --replace, retires the unreproduced item and makes the session due for a new index',
    async () => {
      const { prompt, statement } = await extractedEarlier()

      const { outcome, emitted, calls } = await extract(true)

      expect(outcome).toMatchObject({ exitCode: EXIT_OK, windows: 1, calls: 1 })
      expect(calls).toBe(1)
      expect(emitted).toEqual([expect.objectContaining({ anchor: prompt, status: 'succeeded', stored: 0, retired: [statement] })])
      const run = await pg.psql(
        `SELECT id FROM public.memory_extraction_runs WHERE extractor_version = '${EXTRACTOR_VERSION}' AND status = 'succeeded';`,
      )
      expect(await pg.psql(`SELECT retired_reason FROM public.memory_items WHERE id = '${statement}';`)).toBe(
        `replaced by extractor ${EXTRACTOR_VERSION} (run ${run})`,
      )
      expect(await indexDue()).toBe('t')
    },
    TEST_TIMEOUT_MS,
  )
})
