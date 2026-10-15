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
  runMemoryGet,
  runMemoryRecall,
} from '../src/recall-tools.js'
import type { RecallRouteDeps } from '../src/recall-route.js'
import { TST_ITEM_ID, TST_T0, stubRecallDeps } from './recall-fixtures.js'

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
