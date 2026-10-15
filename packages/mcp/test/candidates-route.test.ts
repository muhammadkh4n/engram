import { describe, expect, it, vi } from 'vitest'
import type { ReviewCandidateRow, ReviewCandidatesRequest } from '@engram-mem/core'
import { parseCandidatesRequest, runCandidatesRequest, type CandidatesRouteDeps } from '../src/candidates-route.js'

const ID_A = '01970000-0000-7000-8000-0000000000a1'
const ID_B = '01970000-0000-7000-8000-0000000000b2'
const ID_C = '01970000-0000-7000-8000-0000000000c3'

function row(overrides: Partial<ReviewCandidateRow> = {}): ReviewCandidateRow {
  return {
    id: ID_A,
    kind: 'ruling',
    quote: 'tst keep the floor at 0.3',
    question: 'tst where should the floor sit?',
    occurredAt: new Date('2026-02-03T04:00:00Z'),
    sessionId: 'tst-session-1',
    projectId: 'tst-repo',
    workspaceId: null,
    subject: 'tst floor',
    proposedScope: 'project:tst-repo',
    status: 'current',
    registerStatus: 'candidate',
    restatedCount: 1,
    targets: [],
    total: 1,
    ...overrides,
  }
}

function deps(rows: ReviewCandidateRow[] = [row()]) {
  const reviewCandidates = vi.fn(async (_req: ReviewCandidatesRequest) => rows)
  const logError = vi.fn()
  const value: CandidatesRouteDeps = { getStore: async () => ({ reviewCandidates }), logError }
  return { deps: value, reviewCandidates, logError }
}

describe('parseCandidatesRequest', () => {
  it('takes the scope, a default limit of 4, and lower-cased ids', () => {
    expect(parseCandidatesRequest({ scope: {} })).toEqual({ value: { scope: {}, limit: 4 } })
    expect(parseCandidatesRequest({ scope: { project_id: ' tst-repo ', workspace_id: 'tst-ws' }, limit: 8 })).toEqual({
      value: { scope: { projectId: 'tst-repo', workspaceId: 'tst-ws' }, limit: 8 },
    })
    expect(parseCandidatesRequest({ scope: { project_id: 'global' } })).toEqual({ value: { scope: {}, limit: 4 } })
    expect(parseCandidatesRequest({ scope: {}, ids: [ID_A.toUpperCase(), ID_B] })).toEqual({ value: { scope: {}, limit: 4, ids: [ID_A, ID_B] } })
  })

  it.each([
    [[], 'the body must be a JSON object'],
    [{}, 'scope is required; send {} for none'],
    [{ scope: {}, query: 'q' }, 'the request has an unknown key: query'],
    [{ scope: { plan: 'x' } }, 'scope has an unknown key: plan'],
    [{ scope: { project_id: 'not a repo' } }, 'scope.project_id is not a project id'],
    [{ scope: { workspace_id: 3 } }, 'scope.workspace_id is not a workspace id'],
    [{ scope: {}, limit: 0 }, 'limit must be between 1 and 8'],
    [{ scope: {}, limit: 9 }, 'limit must be between 1 and 8'],
    [{ scope: {}, limit: '4' }, 'limit must be an integer'],
    [{ scope: {}, ids: [] }, 'ids must be a list of 1 to 8 ids'],
    [{ scope: {}, ids: Array.from({ length: 9 }, () => ID_A) }, 'ids must be a list of 1 to 8 ids'],
    [{ scope: {}, ids: ['tst-not-a-uuid'] }, 'ids must be uuids'],
    [{ scope: {}, ids: [ID_A, ID_A.toUpperCase()] }, 'ids names an id twice'],
  ])('refuses %j', (body, error) => {
    expect(parseCandidatesRequest(body)).toEqual({ error })
  })
})

describe('runCandidatesRequest', () => {
  it('answers 200 with keys in contract order', async () => {
    const t = deps([row({ targets: [{ id: ID_B, class: 'document_section', text: 'tst claim', status: 'retired' }], total: 3 })])
    const res = await runCandidatesRequest(t.deps, { scope: { project_id: 'tst-repo' } })
    expect(t.reviewCandidates).toHaveBeenCalledWith({ scope: { projectId: 'tst-repo' }, limit: 4 })
    expect(res.status).toBe(200)
    const body = res.body as { candidates: Array<Record<string, unknown>>; total: number; missing: string[] }
    expect(Object.keys(body)).toEqual(['candidates', 'total', 'missing'])
    expect(Object.keys(body.candidates[0]!)).toEqual([
      'id', 'kind', 'quote', 'question', 'occurred_at', 'session_id', 'project_id', 'workspace_id', 'subject',
      'proposed_scope', 'status', 'register_status', 'restated_count', 'targets',
    ])
    expect(body.candidates[0]).toMatchObject({ occurred_at: '2026-02-03T04:00:00.000Z', targets: [{ id: ID_B, class: 'document_section', text: 'tst claim', status: 'retired' }] })
    expect(body.total).toBe(3)
    expect(body.missing).toEqual([])
  })

  it('lists requested ids with no row as missing, in request order, matching an upper-case id to its row', async () => {
    const t = deps([row({ id: ID_B, total: 1 })])
    const res = await runCandidatesRequest(t.deps, { scope: {}, ids: [ID_A, ID_B.toUpperCase(), ID_C] })
    expect(res.body).toMatchObject({ total: 1, missing: [ID_A, ID_C] })
    expect((res.body as { candidates: Array<{ id: string }> }).candidates.map((c) => c.id)).toEqual([ID_B])
  })

  it('answers total 0 with no row', async () => {
    const t = deps([])
    expect((await runCandidatesRequest(t.deps, { scope: {} })).body).toEqual({ candidates: [], total: 0, missing: [] })
  })

  it('never cuts a statement, cuts a retraction and a target at a sentence boundary, and keeps the question tail', async () => {
    const long = `${'A sentence of the reply. '.repeat(80)}tail`
    const question = `${'q'.repeat(700)}. What is the floor?`
    const t = deps([
      row({ quote: long, question }),
      row({ id: ID_B, kind: 'retraction', quote: long, question: null, registerStatus: null, targets: [{ id: ID_C, class: 'observation', text: long, status: 'current' }] }),
    ])
    const [statement, retraction] = ((await runCandidatesRequest(t.deps, { scope: {} })).body as { candidates: Array<Record<string, any>> }).candidates
    expect(statement!.quote).toBe(long)
    expect(statement!.question).toBe('What is the floor?')
    expect(retraction!.quote.length).toBeLessThanOrEqual(1500)
    expect(retraction!.quote.endsWith('reply.')).toBe(true)
    expect(retraction!.question).toBeNull()
    expect(retraction!.targets[0].text.length).toBeLessThanOrEqual(1500)
  })

  it('answers 400 before any store call, and 500 with the scrubbed cause on stderr only', async () => {
    const bad = deps()
    expect(await runCandidatesRequest(bad.deps, { scope: {}, limit: 0 })).toEqual({ status: 400, body: { error: 'limit must be between 1 and 8' } })
    expect(bad.reviewCandidates).not.toHaveBeenCalled()

    const logError = vi.fn()
    const failing: CandidatesRouteDeps = {
      getStore: async () => ({
        reviewCandidates: async () => {
          throw new Error('store unreachable: Authorization: Bearer Zq7madeupNotReal91xAbc')
        },
      }),
      logError,
    }
    expect(await runCandidatesRequest(failing, { scope: {} })).toEqual({ status: 500, body: { error: 'candidates failed' } })
    expect(logError.mock.calls[0]![0]).toMatch(/^\[engram-mcp-http\] candidates failed: store unreachable/)
    expect(logError.mock.calls[0]![0]).not.toContain('Zq7madeupNotReal91xAbc')
  })
})
