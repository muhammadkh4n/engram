import { describe, expect, it, vi } from 'vitest'
import type { ItemRecord, RecallItem, RecallResponse } from '@engram-mem/core'
import {
  MEMORY_GET_TOOL,
  MEMORY_RECALL_TOOL,
  NO_RECALL_ITEMS,
  RECALL_PREAMBLE,
  getRequestFromArgs,
  recallRequestFromArgs,
  recordStatus,
  renderRecall,
  renderRecords,
  runMemoryCaptureStatus,
  runMemoryGet,
  runMemoryOverview,
  runMemoryRecall,
  runMemoryTimeline,
} from '../src/recall-tools.js'
import type { RecallRouteDeps } from '../src/recall-route.js'
import { TST_ITEM_ID, TST_T0, stubRecallDeps, tstRow } from './recall-fixtures.js'

const NOW = new Date('2026-02-03T04:00:00Z')
const ID_A = '01970000-0000-7000-8000-0000000000a1'
const ID_B = '01970000-0000-7000-8000-0000000000b2'
const ID_C = '01970000-0000-7000-8000-0000000000c3'
const ID_D = '01970000-0000-7000-8000-0000000000d4'

function item(overrides: Partial<RecallItem> = {}): RecallItem {
  return {
    id: ID_A,
    class: 'mk_statement',
    kind: 'ruling',
    speaker: 'mk',
    trust: 0,
    occurredAt: new Date('2026-02-01T10:00:00Z'),
    projectId: 'tst-repo',
    text: 'Keep the tst floor at 0.3.',
    source: { type: 'transcript', ref: 'tst-session-1 41' },
    status: 'current',
    flags: [],
    via: 'query',
    ...overrides,
  }
}

function response(items: RecallItem[], extra: Partial<RecallResponse> = {}): RecallResponse {
  return { items, omitted: { limit: 0, budget: 0, uncuttable: 0 }, ...extra }
}

function textOf(res: { content: Array<{ text: string }> }): string {
  return res.content[0]!.text
}

function routeDeps(overrides: Partial<RecallRouteDeps> = {}): RecallRouteDeps {
  return { getDeps: async () => stubRecallDeps(), log: null, server: 'tst-server', logError: vi.fn(), now: () => NOW, ...overrides }
}

describe('memory_recall arguments', () => {
  it('map by name onto a recall request on channel mcp, project_id into the scope', () => {
    expect(
      recallRequestFromArgs(
        {
          query: '  tst floor  ',
          project_id: ' tst-repo ',
          exclude_session_id: 'tst-session-1',
          include_history: true,
          classes: ['mk_statement', 'observation'],
          kinds: ['ruling'],
          limit: 5,
          max_chars: 800,
          budget_chars: 4000,
          as_of: '2026-02-03T03:00:00Z',
        },
        NOW,
      ),
    ).toEqual({
      value: {
        query: 'tst floor',
        channel: 'mcp',
        scope: { projectId: 'tst-repo' },
        classes: ['mk_statement', 'observation'],
        kinds: ['ruling'],
        excludeSessionId: 'tst-session-1',
        asOf: new Date('2026-02-03T03:00:00Z'),
        limit: 5,
        maxChars: 800,
        budgetChars: 4000,
        includeHistory: true,
      },
    })
    expect(recallRequestFromArgs({ query: 'q' }, NOW)).toEqual({ value: { query: 'q', channel: 'mcp', scope: {} } })
  })

  it.each([
    ['session_id', 'session_id was renamed exclude_session_id'],
    ['token_budget', 'token_budget was replaced by budget_chars'],
    ['conversation_id', 'conversation_id was removed'],
    ['synthesize', 'synthesize was removed'],
  ])('answers the removed argument %s with what replaces it', (arg, message) => {
    const parsed = recallRequestFromArgs({ query: 'q', [arg]: 'x' }, NOW)
    expect('error' in parsed && parsed.error).toMatch(new RegExp(`^${message}`))
  })

  it('refuses an unknown argument, and a value out of range instead of clamping it', () => {
    expect(recallRequestFromArgs({ query: 'q', top_k: 3 }, NOW)).toEqual({ error: 'unknown argument: top_k' })
    expect(recallRequestFromArgs({ query: 'q', limit: 31 }, NOW)).toEqual({ error: 'limit must be between 1 and 30' })
    expect(recallRequestFromArgs({ query: 'q', project_id: 'not a repo' }, NOW)).toEqual({ error: 'project_id is not a project id' })
    expect(recallRequestFromArgs({ query: 'q', kinds: ['commit'] }, NOW)).toEqual({ error: 'kind commit is history: set include_history' })
    expect(recallRequestFromArgs({}, NOW)).toEqual({ error: 'query is required and must be a string' })
  })

  it('has a schema that requires query, takes no other key and names no removed argument', () => {
    expect(MEMORY_RECALL_TOOL.inputSchema.required).toEqual(['query'])
    expect(MEMORY_RECALL_TOOL.inputSchema.additionalProperties).toBe(false)
    expect(Object.keys(MEMORY_RECALL_TOOL.inputSchema.properties).sort()).toEqual(
      ['as_of', 'budget_chars', 'classes', 'exclude_session_id', 'include_history', 'kinds', 'limit', 'max_chars', 'project_id', 'query'],
    )
  })
})

describe('the memory_recall text', () => {
  it('renders matches, associations and the omitted line', () => {
    const text = renderRecall(
      'what is the tst floor?',
      response(
        [
          item({ question: 'Where should the floor sit?' }),
          item({
            id: ID_B,
            class: 'observation',
            kind: 'fact',
            speaker: 'assistant',
            trust: 2,
            occurredAt: new Date('2026-01-20T08:00:00Z'),
            subject: 'tst floor',
            text: 'The floor was measured on the tst set.\nIt held at 0.3.',
            source: { type: 'ingest_tool', ref: 'tst-session-2 tst-utterance-9' },
            status: 'superseded',
            supersededBy: ID_C,
            flags: ['as_of:2026-01-20', 'restated:2'],
            via: 'association',
          }),
        ],
        { omitted: { limit: 1, budget: 2, uncuttable: 0 } },
      ),
    )
    expect(text).toBe(
      [
        '## Engram recall: 2 items for "what is the tst floor?"',
        RECALL_PREAMBLE,
        '',
        '### Matches',
        `- [mk_statement · ruling · mk · trust 0 · 2026-02-01 · current] id ${ID_A}`,
        '  source: transcript tst-session-1 41',
        '  Answering: Where should the floor sit?',
        '  Keep the tst floor at 0.3.',
        '',
        '### Associated',
        `- [observation · fact · assistant · trust 2 · 2026-01-20 · superseded] id ${ID_B}`,
        `  source: ingest_tool tst-session-2 tst-utterance-9 · subject: tst floor · superseded by ${ID_C} · flags: as_of:2026-01-20, restated:2`,
        '  The floor was measured on the tst set.',
        '  It held at 0.3.',
        '',
        '3 more items passed the floor and were not shown: limit 1, budget 2, uncuttable 0.',
      ].join('\n'),
    )
  })

  it('says no item passed the floor when none did', () => {
    expect(renderRecall('q', response([]))).toBe(NO_RECALL_ITEMS)
  })

  it('says how many passed and why when none fit', () => {
    expect(renderRecall('q', response([], { omitted: { limit: 0, budget: 0, uncuttable: 2 } }))).toBe(
      '2 more items passed the floor and were not shown: limit 0, budget 0, uncuttable 2.',
    )
  })

  it('puts one notice per degraded stage under the header, in a fixed order', () => {
    const degraded = { hyde: 'timeout', vector: 'quota', rerank: 'model failed to load', expansion: 'timeout' }
    const text = renderRecall('q', response([item()], { degraded }))
    expect(text.split('\n').slice(2, 6)).toEqual([
      '> Semantic search failed (quota); results come from keyword and subject search only.',
      '> Reranking failed (model failed to load); items are in candidate order and no relevance floor was applied.',
      '> Query expansion failed (timeout).',
      '> Hypothetical-document search failed (timeout).',
    ])
    expect(renderRecall('q', response([], { degraded: { vector: 'quota' } }))).toBe(
      `> Semantic search failed (quota); results come from keyword and subject search only.\n${NO_RECALL_ITEMS}`,
    )
  })

  it('names the query by its first 120 characters on one line', () => {
    const text = renderRecall(`tst\n${'x'.repeat(200)}`, response([item()]))
    expect(text.split('\n')[0]).toBe(`## Engram recall: 1 items for "tst ${'x'.repeat(116)}"`)
  })
})

describe('runMemoryRecall', () => {
  it('recalls in process, renders the items and logs one line on channel mcp', async () => {
    const recordLine = vi.fn()
    const res = await runMemoryRecall(routeDeps({ log: { recordLine } }), { query: 'tst floor', project_id: 'tst-repo' })
    expect(res.isError).toBeUndefined()
    expect(textOf(res)).toContain(`] id ${TST_ITEM_ID}\n  source: vault Tst/Floor.md Floor\n  The tst floor sits at 0.3 for the tst reranker.`)
    expect(recordLine).toHaveBeenCalledTimes(1)
    expect(recordLine.mock.calls[0]![0]).toMatchObject({ v: 2, channel: 'mcp', query: 'tst floor', scope: { project_id: 'tst-repo' } })
  })

  it('logs no session id, only that one was excluded', async () => {
    const recordLine = vi.fn()
    await runMemoryRecall(routeDeps({ log: { recordLine } }), { query: 'tst floor', exclude_session_id: 'tst-live-session-0001' })
    expect(JSON.stringify(recordLine.mock.calls[0]![0])).not.toContain('tst-live-session-0001')
  })

  it('refuses with the reranker id when no floor is measured for it', async () => {
    const res = await runMemoryRecall(routeDeps({ getDeps: async () => stubRecallDeps({ floor: null }) }), { query: 'q' })
    expect(res).toEqual({ content: [{ type: 'text', text: 'Error: recall is not calibrated for reranker tst-reranker' }], isError: true })
  })

  it('answers "recall failed" and sends the scrubbed cause to stderr only', async () => {
    const logError = vi.fn()
    const deps = routeDeps({
      logError,
      getDeps: async () => {
        throw new Error('store unreachable: Authorization: Bearer Zq7madeupNotReal91xAbc')
      },
    })
    const res = await runMemoryRecall(deps, { query: 'q' })
    expect(res).toEqual({ content: [{ type: 'text', text: 'Error: recall failed' }], isError: true })
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]![0]).toMatch(/^\[engram-mcp\] memory_recall failed: store unreachable/)
    expect(logError.mock.calls[0]![0]).not.toContain('Zq7madeupNotReal91xAbc')
  })

  it('logs nothing for a refused argument', async () => {
    const recordLine = vi.fn()
    const res = await runMemoryRecall(routeDeps({ log: { recordLine } }), { query: 'q', session_id: 's' })
    expect(res.isError).toBe(true)
    expect(recordLine).not.toHaveBeenCalled()
  })
})

function record(overrides: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id: ID_A,
    class: 'observation',
    kind: 'fact',
    speaker: 'assistant',
    trust: 2,
    projectId: 'tst-repo',
    workspaceId: null,
    planSlug: null,
    sessionId: 'tst-session-1',
    subjectLabel: 'tst floor',
    contentHead: 'The floor holds at 0.3.',
    contentLength: 23,
    question: null,
    occurredAt: new Date('2026-02-01T10:00:00Z'),
    validTo: null,
    supersededBy: null,
    restated: 0,
    retiredAt: null,
    retiredReason: null,
    standing: null,
    registerStatus: null,
    registerRef: null,
    source: { type: 'ingest_tool', session_id: 'tst-session-1', utterance_id: 'tst-utterance-9' },
    lineage: [],
    embeddingModel: 'tst-embedder',
    contentHash: 'f'.repeat(64),
    extractionRunId: null,
    createdAt: TST_T0,
    ...overrides,
  }
}

describe('memory_get arguments', () => {
  it('takes 1 to 20 uuids, lower-cased and each kept once, and max_chars 200 to 8,000', () => {
    expect(getRequestFromArgs({ ids: [ID_A.toUpperCase(), ID_A, ID_B] })).toEqual({ ids: [ID_A, ID_B], maxChars: 4000 })
    expect(getRequestFromArgs({ ids: [ID_A], max_chars: 200 })).toEqual({ ids: [ID_A], maxChars: 200 })
    expect(getRequestFromArgs({ ids: [] })).toEqual({ error: 'ids must be a list of 1 to 20 item ids' })
    expect(getRequestFromArgs({ ids: Array.from({ length: 21 }, () => ID_A) })).toEqual({ error: 'ids must be a list of 1 to 20 item ids' })
    expect(getRequestFromArgs({ ids: [ID_A, 'tst-not-a-uuid'] })).toEqual({ error: 'ids holds a value that is not a uuid: "tst-not-a-uuid"' })
    expect(getRequestFromArgs({ ids: [ID_A], max_chars: 8001 })).toEqual({ error: 'max_chars must be an integer between 200 and 8000' })
    expect(getRequestFromArgs({ ids: [ID_A], query: 'q' })).toEqual({ error: 'unknown argument: query' })
    expect(MEMORY_GET_TOOL.inputSchema.required).toEqual(['ids'])
  })
})

describe('memory_get', () => {
  it('returns a current, a superseded and a retired record with their status, and lists unknown ids', async () => {
    const getItems = vi.fn(async () => [
      record({ id: ID_C, retiredAt: new Date('2026-02-02T00:00:00Z'), retiredReason: 'tst reason' }),
      record(),
      record({ id: ID_B, supersededBy: ID_A }),
    ])
    const res = await runMemoryGet({ store: { getItems } }, { ids: [ID_A, ID_B, ID_C, ID_D] })
    expect(getItems).toHaveBeenCalledWith([ID_A, ID_B, ID_C, ID_D])
    const text = textOf(res)
    expect(text.split('\n')[0]).toBe('## Engram items: 3 of 4 found')
    expect(text).toContain(`- [observation · fact · assistant · trust 2 · 2026-02-01 · current] id ${ID_A}`)
    expect(text).toContain(`- [observation · fact · assistant · trust 2 · 2026-02-01 · superseded] id ${ID_B}`)
    expect(text).toContain(`  source: ingest_tool tst-session-1 tst-utterance-9 · subject: tst floor · superseded by ${ID_A}`)
    expect(text).toContain(`- [observation · fact · assistant · trust 2 · 2026-02-01 · retired] id ${ID_C}\n`)
    expect(text).toContain('  retired 2026-02-02T00:00:00.000Z: tst reason')
    expect(text.indexOf(`id ${ID_A}`)).toBeLessThan(text.indexOf(`id ${ID_B}`))
    expect(text.indexOf(`id ${ID_B}`)).toBeLessThan(text.indexOf(`id ${ID_C}`))
    expect(text.endsWith(`\n\nNot found: ${ID_D}`)).toBe(true)
  })

  it('renders one whole record as stored', () => {
    expect(renderRecords([ID_A], [record({ question: 'Where does it hold?', lineage: [ID_B], restated: 2 })], 4000)).toBe(
      [
        '## Engram items: 1 of 1 found',
        '',
        `- [observation · fact · assistant · trust 2 · 2026-02-01 · current] id ${ID_A}`,
        '  source: ingest_tool tst-session-1 tst-utterance-9 · subject: tst floor',
        '  scope: project tst-repo · session tst-session-1',
        `  occurred 2026-02-01T10:00:00.000Z · stored ${TST_T0.toISOString()}`,
        '  restated 2 times',
        `  lineage: ${ID_B}`,
        `  content sha256 ${'f'.repeat(64)} · embedded with tst-embedder`,
        '  source record: {"type":"ingest_tool","session_id":"tst-session-1","utterance_id":"tst-utterance-9"}',
        '  Answering: Where does it hold?',
        '  length: 23 characters',
        '  The floor holds at 0.3.',
      ].join('\n'),
    )
  })

  it('cuts a long text at a sentence boundary and says how much is shown', () => {
    const head = `${'A first sentence. '.repeat(20)}tail`
    const text = renderRecords([ID_A], [record({ contentHead: head, contentLength: head.length })], 200)
    expect(text).toContain(`  length: ${head.length} characters; 197 shown, cut at a sentence boundary`)
    expect(text).not.toContain('tail')
  })

  it('never cuts an MK statement, and marks a text longer than the head it read', () => {
    const quote = `${'MK said this. '.repeat(30)}`.trimEnd()
    const statement = record({ class: 'mk_statement', kind: 'ruling', speaker: 'mk', trust: 0, contentHead: quote, contentLength: quote.length })
    expect(renderRecords([ID_A], [statement], 200)).toContain(`  length: ${quote.length} characters\n  ${quote}`)
    const head = 'x'.repeat(8001)
    expect(renderRecords([ID_A], [record({ contentHead: head, contentLength: 9000 })], 8000)).toContain(
      '  length: 9000 characters; 8001 shown, the first characters only',
    )
  })

  it('takes the status from retired_at, then superseded_by', () => {
    expect(recordStatus({ retiredAt: TST_T0, supersededBy: ID_B })).toBe('retired')
    expect(recordStatus({ retiredAt: null, supersededBy: ID_B })).toBe('superseded')
    expect(recordStatus({ retiredAt: null, supersededBy: null })).toBe('current')
  })

  it('answers a malformed id as an error without reading the store', async () => {
    const getItems = vi.fn(async () => [])
    const res = await runMemoryGet({ store: { getItems } }, { ids: ['tst-not-a-uuid'] })
    expect(res).toEqual({ content: [{ type: 'text', text: 'Error: ids holds a value that is not a uuid: "tst-not-a-uuid"' }], isError: true })
    expect(getItems).not.toHaveBeenCalled()
  })
})

describe('memory_timeline', () => {
  const entry = (id: string, minute: number, overrides: Record<string, unknown> = {}) => {
    const contentHead = `Session tst-session-${minute}\nProject: tst-repo`
    return {
      id,
      sessionId: `tst-session-${minute}`,
      projectId: 'tst-repo' as string | null,
      occurredAt: new Date(Date.parse('2026-02-01T10:00:00Z') + minute * 60_000),
      contentHead,
      contentLength: contentHead.length,
      ...overrides,
    }
  }

  function timelineDeps(rows: ReturnType<typeof entry>[], recall: Partial<RecallRouteDeps> = {}) {
    const sessionTimeline = vi.fn(async () => rows)
    return { deps: { store: { sessionTimeline }, recall: routeDeps(recall) }, sessionTimeline }
  }

  it('lists the session records newest first, each cut at a line boundary', async () => {
    const long = `Session tst-session-5\n${Array.from({ length: 40 }, (_, k) => `${String(k).padStart(2, '0')} ${'p'.repeat(60)}`).join('\n')}`
    const { deps, sessionTimeline } = timelineDeps([entry(ID_B, 5, { contentHead: long, contentLength: long.length, projectId: null }), entry(ID_A, 0)])
    const res = await runMemoryTimeline(deps, { project_id: ' tst-repo ', from_date: '2026-02-01', to_date: '2026-02-01T12:00:00Z', limit: 5 })
    expect(sessionTimeline).toHaveBeenCalledWith({ limit: 5, projectId: 'tst-repo', from: '2026-02-01T00:00:00Z', to: '2026-02-01T12:00:00Z' })
    const text = textOf(res)
    const lines = text.split('\n')
    expect(lines[0]).toBe('## Engram timeline: 2 sessions · project tst-repo · from 2026-02-01T00:00:00Z · to 2026-02-01T12:00:00Z')
    expect(lines[2]).toBe(`- 2026-02-01 10:05 UTC · no project · session tst-session-5 · item ${ID_B}`)
    expect(text).toContain(`  [cut: memory_get ${ID_B} returns the whole record]`)
    const shown = text.slice(text.indexOf('  Session tst-session-5'), text.indexOf('  [cut:'))
    expect(shown.length).toBeLessThanOrEqual(1500 + 2 * 40)
    expect(shown.trimEnd().endsWith('p'.repeat(60))).toBe(true)
    expect(text.endsWith(`- 2026-02-01 10:00 UTC · tst-repo · session tst-session-0 · item ${ID_A}\n  Session tst-session-0\n  Project: tst-repo`)).toBe(true)
  })

  it('makes a date alone a whole UTC day', async () => {
    const { deps, sessionTimeline } = timelineDeps([])
    expect(textOf(await runMemoryTimeline(deps, { from_date: '2026-02-01', to_date: '2026-02-02' }))).toBe('No session record matches.')
    expect(sessionTimeline).toHaveBeenCalledWith({ limit: 20, from: '2026-02-01T00:00:00Z', to: '2026-02-02T23:59:59.999999Z' })
  })

  it.each([
    [{ from_date: 'last week' }, 'from_date must be an ISO 8601 date (YYYY-MM-DD) or a time with an offset'],
    [{ from_date: '2026-02-30' }, 'from_date must be an ISO 8601 date (YYYY-MM-DD) or a time with an offset'],
    [{ to_date: '2026-02-01T10:00:00' }, 'to_date must be an ISO 8601 date (YYYY-MM-DD) or a time with an offset'],
    [{ from_date: '2026-02-02', to_date: '2026-02-01' }, 'from_date is after to_date'],
    [{ limit: 51 }, 'limit must be an integer between 1 and 50'],
    [{ query: 'q', limit: 31 }, 'limit with query must be between 1 and 30'],
    [{ topic: 'tst' }, 'topic was replaced by query: it lists only the sessions relevant to it'],
    [{ project_id: 'not a repo' }, 'project_id is not a project id'],
  ])('refuses %o', async (args, message) => {
    const { deps, sessionTimeline } = timelineDeps([])
    expect(await runMemoryTimeline(deps, args)).toEqual({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true })
    expect(sessionTimeline).not.toHaveBeenCalled()
  })

  it('with a query, lists the current session records recall shows, filtered by project and dates, newest first', async () => {
    const row = (id: string, minute: number, projectId: string) =>
      tstRow({
        id,
        currentId: id,
        class: 'session_index',
        kind: 'session',
        speaker: 'system',
        projectId,
        sessionId: `tst-session-${minute}`,
        contentHead: `Session tst-session-${minute}\nProject: ${projectId}`,
        contentLength: `Session tst-session-${minute}\nProject: ${projectId}`.length,
        occurredAt: new Date(Date.parse('2026-02-01T10:00:00Z') + minute * 60_000),
        source: { type: 'transcript', session_id: `tst-session-${minute}` },
      })
    const recordLine = vi.fn()
    const { deps, sessionTimeline } = timelineDeps([], {
      log: { recordLine },
      getDeps: async () => stubRecallDeps({ rows: [row(ID_A, 0, 'tst-repo'), row(ID_B, 5, 'tst-repo'), row(ID_C, 9, 'tst-other')] }),
    })
    const text = textOf(await runMemoryTimeline(deps, { query: 'tst floor', project_id: 'tst-repo', limit: 10 }))
    expect(sessionTimeline).not.toHaveBeenCalled()
    expect(text.split('\n')[0]).toBe('## Engram timeline: 2 sessions · for "tst floor" · project tst-repo')
    expect(text.indexOf(`item ${ID_B}`)).toBeLessThan(text.indexOf(`item ${ID_A}`))
    expect(text).not.toContain(ID_C)
    expect(recordLine.mock.calls[0]![0]).toMatchObject({ channel: 'mcp', classes: ['session_index'], include_history: true })
  })

  it('with a query, refuses when no floor is measured for the reranker', async () => {
    const { deps } = timelineDeps([], { getDeps: async () => stubRecallDeps({ floor: null }) })
    expect(textOf(await runMemoryTimeline(deps, { query: 'q' }))).toBe('Error: recall is not calibrated for reranker tst-reranker')
  })
})

describe('memory_overview', () => {
  it('lists counts by class and kind, the states and the top subjects', async () => {
    const latest = new Date('2026-02-01T10:00:00Z')
    const itemOverview = vi.fn(async () => [
      { section: 'class' as const, key: 'mk_statement/ruling', n: 4, latest },
      { section: 'class' as const, key: 'utterance/user_prompt', n: 30, latest },
      { section: 'state' as const, key: 'superseded', n: 2, latest },
      { section: 'state' as const, key: 'retired', n: 0, latest: null },
      { section: 'state' as const, key: 'candidate', n: 1, latest },
      { section: 'subject' as const, key: 'tst floor', n: 3, latest },
    ])
    const res = await runMemoryOverview({ store: { itemOverview } }, { project_id: 'tst-repo', subjects: 5 })
    expect(itemOverview).toHaveBeenCalledWith({ subjectLimit: 5, projectId: 'tst-repo' })
    expect(textOf(res)).toBe(
      [
        '## Engram overview: project tst-repo',
        '',
        '### Current items by class and kind',
        '- mk_statement/ruling: 4 (latest 2026-02-01)',
        '- utterance/user_prompt: 30 (latest 2026-02-01)',
        '',
        '### Not current, and waiting for review',
        '- superseded: 2 (latest 2026-02-01)',
        '- retired: 0',
        '- candidate: 1 (latest 2026-02-01)',
        '',
        '### Subjects with the most current items',
        '- tst floor: 3 (latest 2026-02-01)',
      ].join('\n'),
    )
  })

  it.each([
    [{ max_communities: 3 }, 'max_communities was replaced by subjects: how many top subjects to list, 1 to 50'],
    [{ topic: 'tst' }, 'topic was removed: memory_overview counts everything; pass project_id to narrow it, or search with memory_recall'],
    [{ subjects: 0 }, 'subjects must be an integer between 1 and 50'],
  ])('refuses %o', async (args, message) => {
    const itemOverview = vi.fn(async () => [])
    expect(await runMemoryOverview({ store: { itemOverview } }, args)).toEqual({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true })
    expect(itemOverview).not.toHaveBeenCalled()
  })
})

describe('memory_capture_status', () => {
  it('lists each metric with its value, none when there is no value', async () => {
    const captureStatus = vi.fn(async () => [
      { metric: 'events_received_24h', value: '12' },
      { metric: 'oldest_unprocessed_received_at', value: null },
    ])
    expect(textOf(await runMemoryCaptureStatus({ store: { captureStatus } }, {}))).toBe(
      '## Engram capture status\n- events_received_24h: 12\n- oldest_unprocessed_received_at: none',
    )
    expect(await runMemoryCaptureStatus({ store: { captureStatus } }, { verbose: true })).toEqual({
      content: [{ type: 'text', text: 'Error: unknown argument: verbose' }],
      isError: true,
    })
  })
})
