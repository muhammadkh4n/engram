import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectRegistry } from '../../src/decisions/as-of.js'
import type { DecisionCase } from '../../src/decisions/cases.js'
import {
  ChannelProfileError,
  decisionPointLane,
  newQueryLane,
  oldQueryLane,
  parseChannelProfiles,
  postgrestCreatedAt,
  queryInputs,
  registersInForce,
  replayCase,
  scopeLane,
  type CreatedAtLookup,
  type OldRecaller,
  type ScopeRoots,
} from '../../src/decisions/lanes.js'
import {
  RecallClient,
  RecallResponseError,
  RecallStopError,
  assertReplayStoreUrl,
} from '../../src/decisions/recall-client.js'
import type { EvalRecall } from '../../src/eval/eval-stack.js'

const SESSION = 'abcdefab-1111-2222-3333-444455556666'
const DECIDED = '2026-09-30T10:00:00.000Z'
const ITEM_TEXT = 'the reporting api listens on port 3000'
const ITEM_QUESTION = 'which port does it use?'

function makeCase(o: Partial<DecisionCase> = {}): DecisionCase {
  return {
    id: 'TST-CASE-1',
    source: { kind: 'incident', ref: 'TST-CASE-1' },
    status: 'reviewed',
    decided_at: DECIDED,
    agent: 'main',
    channel: 'prompt',
    session_id: SESSION,
    transcript: null,
    cwd: null,
    project_id: 'synthetic-project',
    workspace_id: 'acme',
    at_root: false,
    plan_dirs: ['/home/synthetic/plans/demo-plan'],
    query_text: 'which port does the reporting api use',
    prior_prompts: [],
    decision_kind: null,
    tool_text: null,
    expect_contradiction: false,
    needed: [
      { key: 'port', kind: 'fact', expected_lane: 'query', phrases: [['port 3000']], register_ids: [], item_ids: [], legacy_ids: [] },
    ],
    harmful: [],
    audit: null,
    note: 'synthetic',
    ...o,
  }
}

const PROFILES = JSON.stringify({
  prompt: { limit: 5, budget_chars: 4000 },
  agent_dispatch: { classes: ['ruling', 'procedure'], limit: 10 },
  executor_start: { limit: 10 },
  hand_recall: {
    classes: ['ruling', 'fact'],
    limit: 8,
    max_chars: 1200,
    budget_chars: 6000,
    include_history: false,
    exclude_live_session: true,
  },
})

function recallItem(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-one',
    class: 'mk_statement',
    kind: 'ruling',
    speaker: 'mk',
    trust: 3,
    occurred_at: '2026-09-20T08:00:00Z',
    project_id: 'synthetic-project',
    text: ITEM_TEXT,
    question: ITEM_QUESTION,
    source: { type: 'transcript', ref: 'synthetic.jsonl:12' },
    status: 'current',
    flags: [],
    via: 'query',
    ...o,
  }
}

const OMITTED = { limit: 0, budget: 0, uncuttable: 0 }

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: unknown
}

interface Stub {
  base: string
  seen: Seen[]
}

let tmp: string
let servers: http.Server[]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-lanes-'))
  servers = []
})

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function stub(reply: (body: unknown, req: http.IncomingMessage) => { status?: number; json: unknown }): Promise<Stub> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    req.on('end', () => {
      const body: unknown = raw === '' ? null : JSON.parse(raw)
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const r = reply(body, req)
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.json))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, seen }
}

function tokenFile(): string {
  const file = path.join(tmp, 'token')
  fs.writeFileSync(file, 'synthetic-bearer\n', { mode: 0o600 })
  return file
}

function clientFor(s: Stub): RecallClient {
  return RecallClient.open({ recallUrl: `${s.base}/recall`, tokenFile: tokenFile(), env: {} })
}

// ── RecallClient ─────────────────────────────────────────────────────────

describe('RecallClient', () => {
  it('refuses a rexvps host and the origin of the live server', () => {
    expect(() => assertReplayStoreUrl('https://rexvps.example.net/recall', {})).toThrow(RecallStopError)
    expect(() => assertReplayStoreUrl('http://127.0.0.1:4100/recall', { ENGRAM_SERVER_URL: 'http://127.0.0.1:4100/mcp' })).toThrow(
      RecallStopError,
    )
    expect(assertReplayStoreUrl('http://127.0.0.1:4101/recall', { ENGRAM_SERVER_URL: 'http://127.0.0.1:4100/mcp' }).origin).toBe(
      'http://127.0.0.1:4101',
    )
    expect(() => RecallClient.open({ recallUrl: 'https://REXVPS.example.net/recall', tokenFile: tokenFile(), env: {} })).toThrow(
      expect.objectContaining({ reason: 'refused-url' }),
    )
  })

  it('stops the run on a degraded response', async () => {
    const s = await stub(() => ({ json: { items: [recallItem()], omitted: OMITTED, degraded: { vector: 'down' } } }))
    await expect(newQueryLane(makeCase(), clientFor(s), parseChannelProfiles(PROFILES))).rejects.toMatchObject({
      name: 'RecallStopError',
      reason: 'degraded',
    })
  })

  it('stops the run on an unknown status or route, or an item without id, text or source', async () => {
    const broken = [
      recallItem({ status: 'stale' }),
      recallItem({ via: 'guess' }),
      recallItem({ id: undefined }),
      recallItem({ text: undefined }),
      recallItem({ source: undefined }),
    ]
    for (const item of broken) {
      const s = await stub(() => ({ json: { items: [item], omitted: OMITTED } }))
      await expect(newQueryLane(makeCase(), clientFor(s), parseChannelProfiles(PROFILES))).rejects.toBeInstanceOf(RecallResponseError)
    }
  })

  it('stops on an error status without echoing the body', async () => {
    const s = await stub(() => ({ status: 503, json: { error: 'no calibrated floor' } }))
    await expect(newQueryLane(makeCase(), clientFor(s), parseChannelProfiles(PROFILES))).rejects.toThrow(/^recall returned HTTP 503$/)
  })
})

// ── Channel profiles ─────────────────────────────────────────────────────

describe('parseChannelProfiles', () => {
  it('needs every query-lane channel and refuses anything else', () => {
    const profiles = JSON.parse(PROFILES) as Record<string, unknown>
    const without = { ...profiles }
    delete without['executor_start']
    expect(() => parseChannelProfiles(JSON.stringify(without))).toThrow(ChannelProfileError)
    expect(() => parseChannelProfiles(JSON.stringify({ ...profiles, session_start: {} }))).toThrow(ChannelProfileError)
    expect(() => parseChannelProfiles(JSON.stringify({ ...profiles, prompt: { kinds: ['ruling'] } }))).toThrow(ChannelProfileError)
    expect(() => parseChannelProfiles(JSON.stringify({ ...profiles, prompt: { limit: 31 } }))).toThrow(ChannelProfileError)
    expect(parseChannelProfiles(PROFILES).sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ── Query lane, new arm ──────────────────────────────────────────────────

describe('newQueryLane', () => {
  it('sends the case channel, as_of, scope with plan slugs, profile fields and the bearer', async () => {
    const s = await stub(() => ({ json: { items: [recallItem()], omitted: OMITTED } }))
    const c = makeCase({
      channel: 'hand_recall',
      query_text: 'reporting api port',
      prior_prompts: [{ text: 'start the reporting work', at: '2026-09-30T09:00:00.000Z' }],
    })
    const lane = await newQueryLane(c, clientFor(s), parseChannelProfiles(PROFILES))
    const scope = { project_id: 'synthetic-project', workspace_id: 'acme', plan_slugs: ['demo-plan'] }
    expect(s.seen.map((x) => x.body)).toEqual([
      { query: 'start the reporting work', scope, channel: 'prompt', as_of: '2026-09-30T09:00:00.000Z', limit: 5, budget_chars: 4000 },
      {
        query: 'reporting api port',
        scope,
        channel: 'hand_recall',
        as_of: DECIDED,
        classes: ['ruling', 'fact'],
        limit: 8,
        max_chars: 1200,
        budget_chars: 6000,
        include_history: false,
        exclude_session_id: SESSION,
      },
    ])
    expect(s.seen.every((x) => x.method === 'POST' && x.url === '/recall')).toBe(true)
    expect(s.seen.map((x) => x.headers.authorization)).toEqual(['Bearer synthetic-bearer', 'Bearer synthetic-bearer'])
    expect(lane!.items[1]).toMatchObject({
      form: 'recall_item',
      request: 1,
      id: 'item-one',
      status: 'current',
      via: 'query',
      speaker: 'mk',
      source: { type: 'transcript', ref: 'synthetic.jsonl:12' },
      text: `${ITEM_TEXT}\n${ITEM_QUESTION}`,
    })
    const chars = ITEM_TEXT.length + ITEM_QUESTION.length
    expect(lane!.requests.map((r) => [r.input, r.channel, r.budget_chars, r.payload_chars])).toEqual([
      ['prior_prompt', 'prompt', 4000, chars],
      ['query_text', 'hand_recall', 6000, chars],
    ])
  })

  it('sends no project at a workspace root, and the default budget when the profile names none', async () => {
    const s = await stub(() => ({ json: { items: [], omitted: OMITTED } }))
    const lane = await newQueryLane(
      makeCase({ channel: 'executor_start', agent: 'executor', at_root: true }),
      clientFor(s),
      parseChannelProfiles(PROFILES),
    )
    expect((s.seen[0]!.body as { scope: unknown }).scope).toEqual({ workspace_id: 'acme', plan_slugs: ['demo-plan'], at_root: true })
    expect(lane!.requests[0]!.budget_chars).toBe(9000)
  })

  it('ignores the prior prompts of a subagent case', async () => {
    const s = await stub(() => ({ json: { items: [], omitted: OMITTED } }))
    const c = makeCase({
      agent: 'subagent',
      channel: 'agent_dispatch',
      query_text: 'dispatch the reviewer',
      prior_prompts: [{ text: 'review the reporting api', at: '2026-09-30T09:00:00.000Z' }],
    })
    await newQueryLane(c, clientFor(s), parseChannelProfiles(PROFILES))
    expect(s.seen.map((x) => (x.body as { channel: string; query: string }).query)).toEqual(['dispatch the reviewer'])
    expect((s.seen[0]!.body as { channel: string }).channel).toBe('agent_dispatch')
    expect(queryInputs(c, 'new')).toHaveLength(1)
  })

  it('cuts a prior prompt over the query limit head and tail', () => {
    const long = `${'a'.repeat(1500)}${'b'.repeat(1500)}`
    const inputs = queryInputs(makeCase({ prior_prompts: [{ text: long, at: '2026-09-30T09:00:00.000Z' }] }), 'new')
    expect(inputs[0]!.text).toBe(`${'a'.repeat(1000)}${'b'.repeat(1000)}`)
  })

  it('sends nothing for a channel without a query lane', async () => {
    const s = await stub(() => ({ json: { items: [], omitted: OMITTED } }))
    const c = makeCase({ channel: 'session_start', query_text: null, prior_prompts: [{ text: 'hello', at: '2026-09-30T09:00:00.000Z' }] })
    expect(await newQueryLane(c, clientFor(s), parseChannelProfiles(PROFILES))).toBeNull()
    expect(s.seen).toHaveLength(0)
  })
})

// ── Query lane, old arm ──────────────────────────────────────────────────

function fakeStack(formatted: string, items: EvalRecall['items'], calls: { query: string; args: unknown; now: Date }[]): OldRecaller {
  return {
    async recall(query, args, now) {
      calls.push({ query, args, now })
      return { query, recallOpts: { reconsolidate: false, now }, formatted, items, estimatedTokens: 0, degraded: null, timings: null }
    },
  }
}

describe('oldQueryLane', () => {
  const formatted = 'first memory line\nsecond memory line'
  const items: EvalRecall['items'] = [
    { section: 'memories', id: 'old-before', line: 'first memory line', start: 0, end: 17 },
    { section: 'memories', id: 'old-after', line: 'second memory line', start: 18, end: 36 },
  ]

  it('flags an item created after the prompt time as future and recalls with the project and the prompt time', async () => {
    const calls: { query: string; args: unknown; now: Date }[] = []
    const asked: string[][] = []
    const createdAt: CreatedAtLookup = async (ids) => {
      asked.push([...ids])
      return new Map([
        ['old-before', '2026-09-29T10:00:00.123456+00:00'],
        ['old-after', '2026-09-30T10:00:01+00:00'],
      ])
    }
    const lane = await oldQueryLane(makeCase(), fakeStack(formatted, items, calls), createdAt)
    expect(calls).toEqual([{ query: 'which port does the reporting api use', args: { project_id: 'synthetic-project' }, now: new Date(DECIDED) }])
    expect(asked).toEqual([['old-after', 'old-before']])
    expect(lane!.items.map((i) => [i.id, i.future])).toEqual([
      ['old-before', false],
      ['old-after', true],
    ])
    expect(lane!.future_items).toBe(1)
    expect(lane!.requests[0]!.payload_chars).toBe(formatted.length)
    expect(lane!.items[1]!.text).toBe('second memory line')
  })

  it('lists an id the snapshot has no row for, and counts it as not future', async () => {
    const lane = await oldQueryLane(makeCase(), fakeStack(formatted, items, []), async () => new Map([['old-before', '2026-09-01T00:00:00Z']]))
    expect(lane!.undated_ids).toEqual(['old-after'])
    expect(lane!.items[1]).toMatchObject({ created_at: null, future: false })
  })

  it('gives a session_start case no old query lane', async () => {
    const calls: { query: string; args: unknown; now: Date }[] = []
    const c = makeCase({ channel: 'session_start', query_text: null, prior_prompts: [{ text: 'hello there', at: '2026-09-30T09:00:00.000Z' }] })
    expect(await oldQueryLane(c, fakeStack(formatted, items, calls), async () => new Map())).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('recalls only the prior prompts of a main agent on a channel the old pipeline did not serve', async () => {
    const calls: { query: string; args: unknown; now: Date }[] = []
    const prior = [{ text: 'review the reporting api', at: '2026-09-30T09:00:00.000Z' }]
    const sub = makeCase({ agent: 'subagent', channel: 'agent_dispatch', query_text: 'dispatch the reviewer', prior_prompts: prior })
    expect(await oldQueryLane(sub, fakeStack(formatted, items, calls), async () => new Map())).toBeNull()
    const main = makeCase({ channel: 'hand_recall', at_root: true, prior_prompts: prior })
    await oldQueryLane(main, fakeStack(formatted, items, calls), async () => new Map())
    expect(calls.map((x) => [x.query, x.args, x.now.toISOString()])).toEqual([
      ['review the reporting api', {}, '2026-09-30T09:00:00.000Z'],
      ['which port does the reporting api use', {}, DECIDED],
    ])
  })

  it('stops on a degraded old recall', async () => {
    const stack: OldRecaller = {
      async recall(query, _args, now) {
        return { query, recallOpts: { reconsolidate: false, now }, formatted: '', items: [], estimatedTokens: 0, degraded: { vector: 'down' }, timings: null }
      },
    }
    await expect(oldQueryLane(makeCase(), stack, async () => new Map())).rejects.toMatchObject({ reason: 'degraded' })
  })
})

describe('postgrestCreatedAt', () => {
  it('reads id and created_at from the four memory tables with GET only', async () => {
    const s = await stub((_body, req) => {
      const url = new URL(req.url ?? '/', 'http://stub')
      return { json: url.pathname === '/memory_semantic' ? [{ id: 'old-before', created_at: '2026-09-01T00:00:00+00:00' }] : [] }
    })
    const lookup = postgrestCreatedAt({ url: s.base, key: 'synthetic-key', env: {} })
    const found = await lookup(['old-before', 'old-after'])
    expect([...found]).toEqual([['old-before', '2026-09-01T00:00:00+00:00']])
    expect(s.seen.map((x) => new URL(x.url, 'http://stub').pathname)).toEqual([
      '/memory_episodes',
      '/memory_digests',
      '/memory_semantic',
      '/memory_procedural',
    ])
    for (const x of s.seen) {
      const params = new URL(x.url, 'http://stub').searchParams
      expect([x.method, x.headers.apikey, params.get('select')]).toEqual(['GET', 'synthetic-key', 'id,created_at'])
    }
    expect(new URL(s.seen[3]!.url, 'http://stub').searchParams.get('id')).toBe('in.(old-after)')
  })

  it('refuses a rexvps store', () => {
    expect(() => postgrestCreatedAt({ url: 'https://rexvps.example.net/rest', key: 'synthetic-key', env: {} })).toThrow(RecallStopError)
  })
})

// ── Scope and decision-point lanes ───────────────────────────────────────

const FRONT = ['---', 'type: rulings', 'prefix: TST', '---', '# Standing rulings', ''].join('\n')

function entry(o: { id: string; status?: string; at: string; applies?: string; triggers?: string; supersedes?: string }): string {
  return [
    `## ${o.id} · subject of ${o.id}`,
    `- **Status:** ${o.status ?? 'active'}`,
    `- **MK, ${o.at} UTC:** "words of ${o.id}"`,
    '- **Answering:** —',
    '- **Verified:** history 1788521261494',
    `- **Applies to:** ${o.applies ?? '—'}`,
    `- **Triggers:** ${o.triggers ?? '—'}`,
    `- **Supersedes:** ${o.supersedes ?? '—'}`,
    '- **Restated:** —',
    '',
  ].join('\n')
}

const GLOBAL_REGISTER = [FRONT, entry({ id: 'R-TST-5', at: '2026-09-05 08:00', triggers: 'deploy' })].join('\n')

const WORKSPACE_REGISTER = [
  FRONT,
  entry({ id: 'R-TST-1', status: 'superseded by R-TST-2', at: '2026-09-01 10:00', applies: 'enterworktree', triggers: 'agent-dispatch' }),
  entry({ id: 'R-TST-2', at: '2026-09-10 12:30', applies: 'worktree, .env', triggers: 'stakeholder-draft:alice', supersedes: 'R-TST-1' }),
  entry({ id: 'R-TST-3', status: 'dismissed', at: '2026-08-01 09:00', triggers: 'stakeholder-draft:alice' }),
  entry({ id: 'R-TST-4', at: '2026-10-01 09:00', triggers: 'stakeholder-draft:alice' }),
].join('\n')

const PLAN_DECISIONS = {
  decisions: [
    { id: 'tst-dec-deploy', class: 'A', decided: '2026-09-20', trigger: 'deploys', ruling: 'Deploy from the env branch only.', by: 'mk' },
    { id: 'tst-dec-later', class: 'A', decided: '2026-10-05', trigger: 'later', ruling: 'Not yet given.' },
    { id: 'tst-dec-minor', class: 'B', decided: '2026-09-01', trigger: 'naming', ruling: 'Not shown.' },
  ],
}

const REGISTRY: ProjectRegistry = {
  version: 1,
  workspaces: { acme: { root: '/home/synthetic/acme', vault_folder: 'Acme', register_prefix: 'TST' } },
  projects: { 'synthetic-project': { workspace: 'acme', vault_folder: null, register_prefix: null } },
}

function gitIn(repo: string, args: string[], date?: string): string {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commitRepo(dir: string, files: Record<string, string>, date: string): string {
  fs.mkdirSync(dir, { recursive: true })
  gitIn(dir, ['init', '-q', '-b', 'main'])
  gitIn(dir, ['config', 'user.email', 'fixture@example.invalid'])
  gitIn(dir, ['config', 'user.name', 'Fixture'])
  gitIn(dir, ['config', 'commit.gpgsign', 'false'])
  writeFiles(dir, files)
  gitIn(dir, ['add', '-A'])
  gitIn(dir, ['commit', '-q', '-m', 'fixture'], date)
  return gitIn(dir, ['rev-parse', 'HEAD'])
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
}

interface Fixture {
  roots: ScopeRoots
  dotfilesSha: string
  checkoutSha: string
  checkout: string
  planDir: string
}

function fixture(): Fixture {
  const dotfiles = path.join(tmp, 'dotfiles')
  const dotfilesSha = commitRepo(
    dotfiles,
    { 'claude/CLAUDE.md': '# Rules\n\nAlways work in a worktree.', 'claude/rules/common/style.md': 'Small files.' },
    '2026-09-01T00:00:00Z',
  )
  writeFiles(dotfiles, { 'claude/rulings/global.md': GLOBAL_REGISTER })
  const checkout = path.join(tmp, 'checkout')
  const checkoutSha = commitRepo(checkout, { 'AGENTS.md': 'Repo rules.' }, '2026-09-02T00:00:00Z')
  const vaultRoot = path.join(tmp, 'notes')
  writeFiles(vaultRoot, { 'Acme/Rulings.md': WORKSPACE_REGISTER })
  const planDir = path.join(tmp, 'plans', 'demo-plan')
  writeFiles(planDir, { 'ledger.json': JSON.stringify(PLAN_DECISIONS) })
  return { roots: { dotfiles, vaultRoot, registry: REGISTRY }, dotfilesSha, checkoutSha, checkout, planDir }
}

describe('scopeLane', () => {
  it('gives the new arm rule files, registers in force and dated plan decisions, each with its source', () => {
    const f = fixture()
    const missingPlan = path.join(tmp, 'plans', 'no-ledger')
    const c = makeCase({ cwd: f.checkout, plan_dirs: [f.planDir, missingPlan] })
    const lane = scopeLane(c, f.roots, registersInForce(c, f.roots))
    expect(lane.items.map((i) => [i.form, i.id])).toEqual([
      ['rule_paragraph', null],
      ['rule_paragraph', null],
      ['rule_paragraph', null],
      ['rule_paragraph', null],
      ['register_entry', 'R-TST-5'],
      ['register_entry', 'R-TST-2'],
      ['plan_decision', 'tst-dec-deploy'],
    ])
    expect(lane.items[0]).toEqual({
      form: 'rule_paragraph',
      id: null,
      text: '# Rules',
      origin: 'dotfiles',
      path: 'claude/CLAUDE.md',
      sha: f.dotfilesSha,
    })
    expect(lane.items[3]).toMatchObject({ origin: 'checkout', path: 'AGENTS.md', sha: f.checkoutSha, text: 'Repo rules.' })
    expect(lane.items[5]).toMatchObject({
      file: path.join(f.roots.vaultRoot, 'Acme', 'Rulings.md'),
      // The project has no register folder of its own, so it shares the workspace's register, listed once.
      scope: 'project',
      scope_id: 'synthetic-project',
      quoted_at: '2026-09-10T12:30:00Z',
      verified: { level: 'history', ref: '1788521261494' },
    })
    expect(lane.items[5]!.text.startsWith('## R-TST-2 · subject of R-TST-2')).toBe(true)
    expect(lane.items[6]).toMatchObject({ plan_dir: f.planDir, decided: '2026-09-20', text: '- tst-dec-deploy (2026-09-20, by mk) deploys: Deploy from the env branch only.' })
    expect(lane.gaps).toContainEqual({ kind: 'plan-ledger', plan_dir: missingPlan, reason: 'missing-file' })
    expect(lane.dotfiles_sha).toBe(f.dotfilesSha)
    expect(lane.checkout_sha).toBe(f.checkoutSha)
  })

  it('gives the old arm the rule files alone', async () => {
    const f = fixture()
    const calls: { query: string; args: unknown; now: Date }[] = []
    const c = makeCase({ cwd: f.checkout, plan_dirs: [f.planDir], channel: 'session_start', query_text: null })
    const lanes = await replayCase(c, f.roots, { arm: 'old', stack: fakeStack('', [], calls), createdAt: async () => new Map() })
    expect(lanes.scope.items.every((i) => i.form === 'rule_paragraph')).toBe(true)
    expect(lanes.scope.items).toHaveLength(4)
    expect(lanes.decision_point).toBeNull()
    expect(lanes.query).toBeNull()
  })

  it('reports a checkout with no commit before the decision', () => {
    const f = fixture()
    const c = makeCase({ cwd: f.checkout, decided_at: '2026-09-01T12:00:00.000Z' })
    const lane = scopeLane(c, f.roots)
    expect(lane.checkout_sha).toBeNull()
    expect(lane.gaps).toEqual([{ kind: 'rule-files', origin: 'checkout', path: f.checkout, reason: 'no-commit' }])
  })
})

describe('decisionPointLane', () => {
  function pointCase(kind: string, toolText: string | null): DecisionCase {
    return makeCase({ channel: 'decision_point', query_text: null, decision_kind: kind, tool_text: toolText })
  }

  it('matches a stakeholder trigger by that name only', () => {
    const f = fixture()
    const alice = pointCase('stakeholder-draft:alice', null)
    expect(decisionPointLane(alice, registersInForce(alice, f.roots))!.items.map((i) => [i.id, i.matched_by])).toEqual([
      ['R-TST-2', ['trigger']],
    ])
    const bob = pointCase('stakeholder-draft:bob', null)
    expect(decisionPointLane(bob, registersInForce(bob, f.roots))!.items).toEqual([])
    const deploy = pointCase('deploy', null)
    expect(decisionPointLane(deploy, registersInForce(deploy, f.roots))!.items.map((i) => i.id)).toEqual(['R-TST-5'])
  })

  it('lists the entry whose applies-to token is in the tool text, whole word and any case', () => {
    const f = fixture()
    const hit = pointCase('merge', 'Next we open a WorkTree and copy the .env file.')
    const lane = decisionPointLane(hit, registersInForce(hit, f.roots))!
    expect(lane.contradiction_hits).toEqual([
      { entry_id: 'R-TST-2', file: path.join(f.roots.vaultRoot, 'Acme', 'Rulings.md'), tokens: ['worktree', '.env'] },
    ])
    expect(lane.items.map((i) => [i.id, i.matched_by])).toEqual([['R-TST-2', ['applies_to']]])
    const partial = pointCase('merge', 'Several worktrees and an envelope.')
    expect(decisionPointLane(partial, registersInForce(partial, f.roots))!.contradiction_hits).toEqual([])
  })

  it('is absent outside the decision-point channel', () => {
    const f = fixture()
    const c = makeCase({ decision_kind: null })
    expect(decisionPointLane(c, registersInForce(c, f.roots))).toBeNull()
  })
})
