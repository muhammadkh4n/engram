import { describe, expect, it, vi } from 'vitest'
import { runRecall } from '@engram-mem/core'
import { buildRecallLogLineV2, parseRecallRequest, runRecallRequest, type RecallRouteDeps } from '../src/recall-route.js'
import { TST_T0, stubRecallDeps } from './recall-fixtures.js'

const NOW = new Date('2026-02-03T04:00:00Z')
const base = { query: 'what is the tst floor?', channel: 'hand_recall', scope: {} }
const parse = (body: unknown) => parseRecallRequest(body, NOW)
const errorOf = (body: unknown) => {
  const r = parse(body)
  return 'error' in r ? r.error : null
}

describe('parseRecallRequest', () => {
  it('accepts the smallest request and trims the query', () => {
    expect(parse({ ...base, query: '  tst  ' })).toEqual({ value: { query: 'tst', channel: 'hand_recall', scope: {} } })
  })

  it('refuses a body that is not an object, and an unknown key at the top or in scope', () => {
    expect(errorOf([])).toBe('the body must be a JSON object')
    expect(errorOf({ ...base, top_k: 3 })).toBe('the request has an unknown key: top_k')
    expect(errorOf({ ...base, scope: { project: 'tst-repo' } })).toBe('scope has an unknown key: project')
  })

  it('requires query, channel and scope', () => {
    expect(errorOf({ channel: 'mcp', scope: {} })).toBe('query is required and must be a string')
    expect(errorOf({ query: 'q', scope: {} })).toMatch(/^channel is required/)
    expect(errorOf({ query: 'q', channel: 'nope', scope: {} })).toMatch(/^channel is required/)
    expect(errorOf({ query: 'q', channel: 'mcp' })).toBe('scope is required; send {} for none')
  })

  it('holds the query to 1 to 2,000 characters after trimming', () => {
    expect(errorOf({ ...base, query: '   ' })).toBe('query must be 1 to 2000 characters after trimming')
    expect(errorOf({ ...base, query: 'x'.repeat(2001) })).toBe('query must be 1 to 2000 characters after trimming')
    expect(errorOf({ ...base, query: ` ${'x'.repeat(2000)} ` })).toBeNull()
  })

  it.each([
    ['limit', 0, 1, 30, 31],
    ['max_chars', 199, 200, 4000, 4001],
    ['budget_chars', 999, 1000, 12000, 12001],
  ] as const)('refuses %s outside its range instead of clamping it', (key, below, lo, hi, above) => {
    expect(errorOf({ ...base, [key]: below })).toMatch(new RegExp(`^${key} must be between ${lo} and ${hi}$`))
    expect(errorOf({ ...base, [key]: above })).toMatch(new RegExp(`^${key} must be between`))
    expect(errorOf({ ...base, [key]: lo })).toBeNull()
    expect(errorOf({ ...base, [key]: hi })).toBeNull()
    expect(errorOf({ ...base, [key]: lo + 0.5 })).toBe(`${key} must be an integer`)
    expect(errorOf({ ...base, [key]: String(lo) })).toBe(`${key} must be an integer`)
  })

  it('refuses at_root with a project, and normalises the project id', () => {
    expect(errorOf({ ...base, scope: { at_root: true, project_id: 'tst-repo' } })).toBe('scope.at_root and scope.project_id exclude each other')
    expect(parse({ ...base, scope: { project_id: ' tst-repo ' } })).toEqual({ value: { ...base, scope: { projectId: 'tst-repo' } } })
    expect(parse({ ...base, scope: { project_id: 'global' } })).toEqual({ value: { ...base, scope: {} } })
    expect(errorOf({ ...base, scope: { project_id: 'not a repo' } })).toBe('scope.project_id is not a project id')
    expect(errorOf({ ...base, scope: { at_root: 'yes' } })).toBe('scope.at_root must be a boolean')
  })

  it('takes 1 to 10 kebab-case plan slugs, each once', () => {
    expect(errorOf({ ...base, scope: { plan_slugs: [] } })).toBe('scope.plan_slugs must be a non-empty list')
    expect(errorOf({ ...base, scope: { plan_slugs: Array.from({ length: 11 }, (_, i) => `tst-plan-${i}`) } })).toBe('scope.plan_slugs holds at most 10 slugs')
    expect(errorOf({ ...base, scope: { plan_slugs: ['Tst_Plan'] } })).toBe('scope.plan_slugs must be kebab-case slugs')
    expect(errorOf({ ...base, scope: { plan_slugs: ['tst-plan', 'tst-plan'] } })).toBe('scope.plan_slugs names a slug twice')
  })

  it('refuses an unknown class, and applies the class and channel rules', () => {
    expect(errorOf({ ...base, classes: [] })).toBe('classes must be a non-empty list')
    expect(errorOf({ ...base, classes: ['episode'] })).toBe('classes holds an unknown class: episode')
    expect(errorOf({ ...base, classes: ['session_index'] })).toBe('class session_index is history: set include_history')
    expect(errorOf({ ...base, kinds: ['commit'] })).toBe('kind commit is history: set include_history')
    expect(errorOf({ ...base, classes: ['artifact'], kinds: ['note'] })).toBe('kind note belongs to none of the classes searched')
  })

  it('lets the prompt channel ask for observations, which recall caps at verified ones', () => {
    expect(errorOf({ ...base, channel: 'prompt', classes: ['observation'] })).toBeNull()
  })

  it('checks the excluded session and as_of', () => {
    expect(errorOf({ ...base, exclude_session_id: '' })).toBe('exclude_session_id must be 1 to 256 characters')
    expect(errorOf({ ...base, exclude_session_id: 's'.repeat(257) })).toBe('exclude_session_id must be 1 to 256 characters')
    expect(errorOf({ ...base, as_of: '2026-02-03' })).toBe('as_of must be an ISO 8601 time with an offset')
    expect(errorOf({ ...base, as_of: '2026-02-03T04:00:00' })).toBe('as_of must be an ISO 8601 time with an offset')
    expect(errorOf({ ...base, as_of: '2026-02-03T04:06:00Z' })).toBe('as_of is more than 5 minutes ahead of the server clock')
    expect(parse({ ...base, as_of: '2026-02-03T09:04:00+05:00' })).toEqual({ value: { ...base, asOf: new Date('2026-02-03T04:04:00Z') } })
    expect(errorOf({ ...base, include_history: 'true' })).toBe('include_history must be a boolean')
  })
})

describe('the recall log line', () => {
  async function lineFor(body: Record<string, unknown>) {
    const parsed = parseRecallRequest(body, NOW)
    if ('error' in parsed) throw new Error(parsed.error)
    const { response, trace } = await runRecall(stubRecallDeps(), parsed.value)
    return buildRecallLogLineV2(parsed.value, response, trace, 'tst-server', TST_T0)
  }

  it('writes no session id, only that one was excluded', async () => {
    const line = await lineFor({ ...base, exclude_session_id: 'tst-live-session-0001' })
    expect(JSON.stringify(line)).not.toContain('tst-live-session-0001')
    expect(line.exclude_session).toBe(true)
  })

  it('gives one request fingerprint for reordered keys and explicit defaults, and another for another request', async () => {
    const a = await lineFor({ query: 'q', channel: 'mcp', scope: { project_id: 'tst-repo', workspace_id: 'tst-ws' } })
    const b = await lineFor({ limit: 12, scope: { workspace_id: 'tst-ws', project_id: 'tst-repo' }, channel: 'mcp', query: ' q ' })
    const c = await lineFor({ query: 'q', channel: 'mcp', scope: { project_id: 'tst-repo' } })
    expect(a.request_fp).toBe(b.request_fp)
    expect(c.request_fp).not.toBe(a.request_fp)
    expect(a.output_fp).toBe(b.output_fp)
  })

  it('records what was shown and the effective limits', async () => {
    const line = await lineFor(base)
    expect(line).toMatchObject({
      v: 2,
      channel: 'hand_recall',
      limit: 12,
      max_chars: 1500,
      budget_chars: 9000,
      server: 'tst-server',
      reranker: 'tst-reranker',
      floor: 0.3,
      store_version: [1, 1],
      omitted: { limit: 0, budget: 0, uncuttable: 0 },
      degraded: [],
    })
    expect(line.items).toEqual([{ id: line.items[0]!.id, rank: 1, via: 'query', status: 'current', chars: line.total_chars }])
  })
})

describe('runRecallRequest', () => {
  it('logs nothing for a refused request and answers its error', async () => {
    const recordLine = vi.fn()
    const deps: RecallRouteDeps = { getDeps: async () => stubRecallDeps(), log: { recordLine }, server: 'tst', logError: vi.fn(), now: () => NOW }
    expect(await runRecallRequest(deps, { query: 'q', channel: 'mcp' })).toEqual({ status: 400, body: { error: 'scope is required; send {} for none' } })
    expect(recordLine).not.toHaveBeenCalled()
  })
})
