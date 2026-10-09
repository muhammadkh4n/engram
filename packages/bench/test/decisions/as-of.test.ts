import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RegisterFormatError,
  checkoutRulesAt,
  entriesInForce,
  parseRegister,
  planDecisionsAt,
  registersFor,
  ruleFilesAt,
  type ProjectRegistry,
} from '../../src/decisions/as-of.js'

const FRONT = [
  '---',
  'type: rulings',
  'scope: workspace:acme',
  'prefix: TST',
  '---',
  '# Standing rulings — Acme',
  '',
  'Intro text that is not an entry.',
  '',
].join('\n')

function entry(o: {
  id: string
  subject?: string
  status?: string
  at: string
  quote?: string
  chose?: boolean
  question?: string
  applies?: string
  triggers?: string
  supersedes?: string
  restated?: string[]
}): string {
  const lines = [
    `## ${o.id} · ${o.subject ?? `subject of ${o.id}`}`,
    `- **Status:** ${o.status ?? 'active'}`,
    `- **MK${o.chose ? ' chose' : ''}, ${o.at} UTC:** "${o.quote ?? `words of ${o.id}`}"`,
    `- **Answering:** ${o.question ? `"${o.question}"` : '—'}`,
    `- **Verified:** history 1788521261494`,
    `- **Applies to:** ${o.applies ?? '—'}`,
    `- **Triggers:** ${o.triggers ?? '—'}`,
    `- **Supersedes:** ${o.supersedes ?? '—'}`,
  ]
  if (o.restated) lines.push('- **Restated:**', ...o.restated)
  else lines.push('- **Restated:** —')
  return lines.join('\n')
}

const REGISTER = [
  FRONT,
  entry({ id: 'R-TST-1', status: 'superseded by R-TST-2', at: '2026-09-01 10:00', applies: 'worktree, enterworktree', triggers: 'agent-dispatch' }),
  '',
  entry({
    id: 'R-TST-2',
    at: '2026-09-10 12:30',
    chose: true,
    question: 'Which rule stands?',
    supersedes: 'R-TST-1',
    triggers: 'stakeholder-draft:alice, deploy',
    restated: ['  - 2026-09-12 08:00 UTC: "said again" (history 1788521261495)'],
  }),
  '',
  entry({ id: 'R-TST-3', status: 'dismissed', at: '2026-08-01 09:00' }),
  '',
  entry({ id: 'R-TST-4', at: '2026-10-01 09:00' }),
  '',
].join('\n')

describe('parseRegister', () => {
  it('reads every entry field and keeps the block whole', () => {
    const entries = parseRegister(REGISTER, 'Acme/Rulings.md')
    expect(entries.map((e) => e.id)).toEqual(['R-TST-1', 'R-TST-2', 'R-TST-3', 'R-TST-4'])
    const [first, second] = entries
    expect(first).toMatchObject({
      subject: 'subject of R-TST-1',
      status: 'superseded',
      supersededBy: 'R-TST-2',
      saidAs: 'words',
      quote: 'words of R-TST-1',
      quotedAt: '2026-09-01T10:00:00Z',
      question: null,
      verified: { level: 'history', ref: '1788521261494' },
      appliesTo: ['worktree', 'enterworktree'],
      triggers: ['agent-dispatch'],
      supersedes: [],
    })
    expect(first!.block.startsWith('## R-TST-1 · subject of R-TST-1\n- **Status:**')).toBe(true)
    expect(first!.block.endsWith('- **Restated:** —')).toBe(true)
    expect(second).toMatchObject({
      saidAs: 'choice',
      question: 'Which rule stands?',
      triggers: ['stakeholder-draft:alice', 'deploy'],
      supersedes: ['R-TST-1'],
    })
    expect(second!.block).toContain('said again')
    expect(entries[2]!.status).toBe('dismissed')
  })

  it('fails a malformed entry with the file and its heading', () => {
    const missing = entry({ id: 'R-TST-5', at: '2026-09-01 10:00' }).replace(/- \*\*Answering:\*\* —\n/, '')
    expect(() => parseRegister(`${FRONT}${missing}\n`, 'Acme/Rulings.md')).toThrow(RegisterFormatError)
    expect(() => parseRegister(`${FRONT}${missing}\n`, 'Acme/Rulings.md')).toThrow(
      /^Acme\/Rulings\.md: ## R-TST-5 · subject of R-TST-5: missing question$/,
    )
    const unquoted = entry({ id: 'R-TST-6', at: '2026-09-01 10:00' }).replace('"words of R-TST-6"', 'words of R-TST-6')
    expect(() => parseRegister(`${FRONT}${unquoted}\n`, 'g.md')).toThrow(/g\.md: ## R-TST-6 .*quotation marks/)
    expect(() => parseRegister(`${FRONT}## R-TST-7 without separator\n`, 'g.md')).toThrow(/g\.md: ## R-TST-7 without separator: heading/)
  })

  it('returns no entries for a register that has none', () => {
    expect(parseRegister(FRONT, 'g.md')).toEqual([])
  })
})

describe('entriesInForce', () => {
  const entries = parseRegister(REGISTER, 'Acme/Rulings.md')
  const ids = (at: string) => entriesInForce(entries, at).map((e) => e.id)

  it('holds the superseded entry until its successor is quoted, then only the successor', () => {
    expect(ids('2026-09-10T12:29:59Z')).toEqual(['R-TST-1'])
    expect(ids('2026-09-10T12:30:00Z')).toEqual(['R-TST-2'])
    expect(ids('2026-09-20T00:00:00+02:00')).toEqual(['R-TST-2'])
  })

  it('never holds a dismissed entry', () => {
    expect(ids('2027-01-01T00:00:00Z')).not.toContain('R-TST-3')
    expect(ids('2026-08-15T00:00:00Z')).toEqual([])
  })

  it('leaves out an entry quoted after the time', () => {
    expect(ids('2026-09-30T23:59:00Z')).not.toContain('R-TST-4')
    expect(ids('2026-10-01T09:00:00Z')).toContain('R-TST-4')
  })

  it('refuses an unreadable time', () => {
    expect(() => entriesInForce(entries, 'yesterday')).toThrow(/not a valid time/)
  })
})

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-as-of-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('registersFor', () => {
  const registry: ProjectRegistry = {
    version: 1,
    workspaces: {
      acme: { root: '/work/acme', vault_folder: 'Acme', register_prefix: 'TST' },
      bare: { root: '/work/bare', vault_folder: null, register_prefix: null },
    },
    projects: {
      'widget-api': { workspace: 'acme', vault_folder: 'Widget', register_prefix: 'WID' },
      'widget-ui': { workspace: 'acme', vault_folder: null, register_prefix: null },
      orphan: { workspace: null, vault_folder: null, register_prefix: null },
    },
  }

  function write(rel: string, text: string): string {
    const file = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return file
  }

  function roots() {
    return { dotfiles: path.join(tmp, 'dotfiles'), vaultRoot: path.join(tmp, 'vault') }
  }

  it('lists the global, the project and the workspace register in that order', () => {
    const global = write('dotfiles/claude/rulings/global.md', REGISTER)
    const project = write('vault/Widget/Rulings.md', REGISTER)
    const workspace = write('vault/Acme/Rulings.md', REGISTER)
    const r = registersFor({ project_id: 'widget-api', workspace_id: 'acme', at_root: false }, registry, roots())
    expect(r.registers.map((x) => [x.scope, x.scopeId, x.file])).toEqual([
      ['global', 'global', global],
      ['project', 'widget-api', project],
      ['workspace', 'acme', workspace],
    ])
    expect(r.registers[1]!.entries).toHaveLength(4)
    expect(r.gaps).toEqual([])
  })

  it('takes the workspace register alone at a root', () => {
    write('dotfiles/claude/rulings/global.md', REGISTER)
    write('vault/Widget/Rulings.md', REGISTER)
    write('vault/Acme/Rulings.md', REGISTER)
    const r = registersFor({ project_id: null, workspace_id: 'acme', at_root: true }, registry, roots())
    expect(r.registers.map((x) => x.scope)).toEqual(['global', 'workspace'])
  })

  it('lists a register shared by a project and its workspace once', () => {
    write('dotfiles/claude/rulings/global.md', REGISTER)
    write('vault/Acme/Rulings.md', REGISTER)
    const r = registersFor({ project_id: 'widget-ui', workspace_id: null, at_root: false }, registry, roots())
    expect(r.registers.map((x) => [x.scope, x.scopeId])).toEqual([
      ['global', 'global'],
      ['project', 'widget-ui'],
    ])
  })

  it('reports a missing vault folder, an unknown project and a missing file without throwing', () => {
    const r = registersFor({ project_id: 'orphan', workspace_id: 'bare', at_root: false }, registry, roots())
    expect(r.registers).toEqual([])
    expect(r.gaps).toEqual([
      { scope: 'global', scopeId: 'global', reason: 'missing-file', file: path.join(tmp, 'dotfiles/claude/rulings/global.md') },
      { scope: 'project', scopeId: 'orphan', reason: 'no-vault-folder', file: null },
      { scope: 'workspace', scopeId: 'bare', reason: 'no-vault-folder', file: null },
    ])
    const unknown = registersFor({ project_id: 'nowhere', workspace_id: null, at_root: false }, registry, roots())
    expect(unknown.gaps).toContainEqual({ scope: 'project', scopeId: 'nowhere', reason: 'not-in-registry', file: null })
    const noFile = registersFor({ project_id: 'widget-api', workspace_id: null, at_root: false }, registry, roots())
    expect(noFile.gaps).toContainEqual({
      scope: 'project',
      scopeId: 'widget-api',
      reason: 'missing-file',
      file: path.join(tmp, 'vault/Widget/Rulings.md'),
    })
  })
})

describe('planDecisionsAt', () => {
  const ledger = {
    decisions: [
      { id: 'tst-dec-storage', class: 'A', trigger: 'storage', ruling: 'One  store\nfor all items.', decided: '2026-09-30' },
      { id: 'tst-dec-capture', class: 'a', trigger: 'capture', ruling: 'Raw events only.', decided: '2026-10-05', by: 'mk', quote: 'raw events, nothing else' },
      { id: 'tst-dec-naming', class: 'B', trigger: 'naming', ruling: 'Not shown.', decided: '2026-09-01' },
      { id: 'tst-dec-undated', class: 'A', trigger: 'undated', ruling: 'No date.', decided: null },
      { id: 'tst-dec-old-rule', class: 'A', trigger: 'old rule', ruling: 'Replaced later.', date: '2026-09-02', superseded_by: 'tst-dec-new-rule' },
      { id: 'tst-dec-new-rule', class: 'A', trigger: 'new rule', ruling: 'The replacement.', decided: '2026-10-03T15:00:00Z' },
    ],
  }

  it('renders the decisions dated at or before the time, one line each', () => {
    const r = planDecisionsAt(ledger, '2026-10-01T12:00:00Z')
    expect(r.decisions.map((d) => d.line)).toEqual([
      '- tst-dec-storage (2026-09-30) storage: One store for all items.',
      '- tst-dec-old-rule (2026-09-02) old rule: Replaced later.',
    ])
    expect(r.undated).toEqual(['tst-dec-undated'])
  })

  it('leaves out a decision dated after the time and drops a superseded one once its successor is dated', () => {
    const r = planDecisionsAt(ledger, '2026-10-05T00:00:00Z')
    expect(r.decisions.map((d) => d.id)).toEqual(['tst-dec-storage', 'tst-dec-capture', 'tst-dec-new-rule'])
    expect(r.decisions[1]!.line).toBe('- tst-dec-capture (2026-10-05, by mk) capture: Raw events only. — MK: "raw events, nothing else"')
    expect(planDecisionsAt(ledger, '2026-10-03T14:59:59Z').decisions.map((d) => d.id)).toEqual(['tst-dec-storage', 'tst-dec-old-rule'])
  })

  it('refuses a decision time without an offset', () => {
    const local = { decisions: [{ id: 'tst-dec-local', class: 'A', trigger: 'x', ruling: 'y', decided: '2026-10-03 15:00' }] }
    expect(() => planDecisionsAt(local, '2026-10-05T00:00:00Z')).toThrow(/neither a day nor a time with an offset/)
  })

  it('reads a ledger without decisions as empty', () => {
    expect(planDecisionsAt({}, '2026-10-01T00:00:00Z')).toEqual({ decisions: [], undated: [] })
  })
})

function gitIn(repo: string, args: string[], date?: string): string {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  gitIn(dir, ['init', '-q', '-b', 'main'])
  gitIn(dir, ['config', 'user.email', 'fixture@example.invalid'])
  gitIn(dir, ['config', 'user.name', 'Fixture'])
  gitIn(dir, ['config', 'commit.gpgsign', 'false'])
}

function commitFiles(repo: string, files: Record<string, string>, date: string): string {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(repo, rel), text)
  }
  gitIn(repo, ['add', '-A'])
  gitIn(repo, ['commit', '-q', '-m', 'fixture'], date)
  return gitIn(repo, ['rev-parse', 'HEAD'])
}

describe('ruleFilesAt and checkoutRulesAt', () => {
  it('reads the rule files of the last commit at or before the time', () => {
    const repo = path.join(tmp, 'dotfiles')
    initRepo(repo)
    const first = commitFiles(
      repo,
      {
        'claude/CLAUDE.md': '# Rules\n\nfirst rule paragraph\n\n  \n\nsecond paragraph\nwraps\n',
        'claude/rules/common/b.md': 'b rule\n',
        'claude/rules/common/a.md': 'a rule\n',
        'claude/rules/common/notes.txt': 'not a rule file\n',
      },
      '2026-09-01T10:00:00Z',
    )
    const second = commitFiles(repo, { 'claude/CLAUDE.md': 'replaced rules\n' }, '2026-09-10T10:00:00Z')

    const between = ruleFilesAt(repo, '2026-09-05T00:00:00Z')
    expect(between.sha).toBe(first)
    expect(between.paragraphs).toEqual([
      { path: 'claude/CLAUDE.md', text: '# Rules' },
      { path: 'claude/CLAUDE.md', text: 'first rule paragraph' },
      { path: 'claude/CLAUDE.md', text: 'second paragraph\nwraps' },
      { path: 'claude/rules/common/a.md', text: 'a rule' },
      { path: 'claude/rules/common/b.md', text: 'b rule' },
    ])
    expect(ruleFilesAt(repo, '2026-09-10T10:00:00Z').sha).toBe(second)
    expect(ruleFilesAt(repo, '2026-09-10T10:00:00.999Z').paragraphs[0]).toEqual({ path: 'claude/CLAUDE.md', text: 'replaced rules' })
    expect(ruleFilesAt(repo, '2026-08-31T23:59:59Z')).toEqual({ sha: null, paragraphs: [] })
  })

  it("reads the checkout's CLAUDE.md and AGENTS.md as of the time, from any directory inside it", () => {
    const repo = path.join(tmp, 'checkout')
    initRepo(repo)
    const first = commitFiles(repo, { 'CLAUDE.md': '@AGENTS.md\n', 'src/x.ts': 'export {}\n' }, '2026-09-01T10:00:00Z')
    commitFiles(repo, { 'AGENTS.md': 'agent rules\n' }, '2026-09-10T10:00:00Z')

    expect(checkoutRulesAt(path.join(repo, 'src'), '2026-09-05T00:00:00Z')).toEqual({
      sha: first,
      paragraphs: [{ path: 'CLAUDE.md', text: '@AGENTS.md' }],
    })
    expect(checkoutRulesAt(repo, '2026-09-11T00:00:00Z').paragraphs.map((p) => p.path)).toEqual(['CLAUDE.md', 'AGENTS.md'])
  })

  it('gives nothing for a directory that is not a checkout or no longer exists', () => {
    const plain = path.join(tmp, 'plain')
    fs.mkdirSync(plain)
    expect(checkoutRulesAt(plain, '2026-09-05T00:00:00Z')).toEqual({ sha: null, paragraphs: [] })
    expect(checkoutRulesAt(path.join(tmp, 'gone'), '2026-09-05T00:00:00Z')).toEqual({ sha: null, paragraphs: [] })
  })
})
