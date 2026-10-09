/**
 * What an agent's scope held at a past moment: the standing-rulings registers,
 * a plan's class-A decisions and the rule files, each rebuilt as of a decision
 * time.
 *
 * The vault has no history, so a register is dated entry by entry: an entry is
 * in force from its quote time until an entry that supersedes it is quoted.
 * Rule files live in the dotfiles repository and the case's checkout, so they
 * are read from git at the last commit at or before the decision time.
 *
 * Register entries mirror the dotfiles rulings registry (`registry.js`): an H2
 * `## <id> · <subject>` followed by eight bullets in a fixed order, the quote
 * stamped `MK, YYYY-MM-DD HH:MM UTC:` (or `MK chose, …` for a picked option),
 * `—` for an empty field and comma-separated lists.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DecisionCase } from './cases.js'

const NONE = '—'
const HEADER_RE = /^## (\S+) · (.+)$/
const BULLET_RE = /^- \*\*(.+?):\*\*(?: (.*))?$/
const RESTATED_RE = /^ {2}- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC: "(.*)" \((transcript|history|ledger) (.+)\)$/
const STATUS_SUPERSEDED_RE = /^superseded by (\S+)$/
const FIELDS = [
  { key: 'status', label: /^Status$/ },
  { key: 'said', label: /^MK( chose)?, (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC$/ },
  { key: 'question', label: /^Answering$/ },
  { key: 'verified', label: /^Verified$/ },
  { key: 'appliesTo', label: /^Applies to$/ },
  { key: 'triggers', label: /^Triggers$/ },
  { key: 'supersedes', label: /^Supersedes$/ },
  { key: 'restated', label: /^Restated$/ },
] as const
type FieldKey = (typeof FIELDS)[number]['key']

const GLOBAL_REGISTER = path.join('claude', 'rulings', 'global.md')
const RULINGS_FILE = 'Rulings.md'
const DOTFILES_CLAUDE = 'claude/CLAUDE.md'
const DOTFILES_RULES_DIR = 'claude/rules/common/'
const CHECKOUT_RULE_FILES = ['CLAUDE.md', 'AGENTS.md']
const GIT_MAX_BUFFER = 64 * 1024 * 1024

export interface RegisterEntry {
  id: string
  subject: string
  /** `active`, `superseded`, or the raw status text of any other entry. */
  status: string
  supersededBy: string | null
  saidAs: 'words' | 'choice'
  quote: string
  /** ISO-8601 UTC time of the quote, minute precision. */
  quotedAt: string
  question: string | null
  verified: { level: string; ref: string }
  appliesTo: string[]
  triggers: string[]
  supersedes: string[]
  /** The entry's markdown, heading included. */
  block: string
}

export class RegisterFormatError extends Error {
  constructor(file: string, heading: string, message: string) {
    super(`${file}: ${heading}: ${message}`)
    this.name = 'RegisterFormatError'
  }
}

function stampToIso(stamp: string): string {
  return `${stamp.slice(0, 10)}T${stamp.slice(11, 16)}:00Z`
}

function parseQuoted(raw: string | undefined): string | null {
  const m = /^"(.*)"$/.exec(raw ?? '')
  return m ? m[1]! : null
}

function parseList(raw: string | undefined): string[] {
  if (raw === undefined || raw === NONE) return []
  return raw.split(',').map((t) => t.trim())
}

interface EntryDraft {
  status?: string
  supersededBy?: string | null
  saidAs?: 'words' | 'choice'
  quote?: string
  quotedAt?: string
  question?: string | null
  verified?: { level: string; ref: string }
  appliesTo?: string[]
  triggers?: string[]
  supersedes?: string[]
}

function applyField(draft: EntryDraft, key: FieldKey, label: RegExpExecArray, value: string | undefined, fail: (m: string) => never): void {
  switch (key) {
    case 'status': {
      if (!value) fail('Status is empty')
      const m = STATUS_SUPERSEDED_RE.exec(value)
      draft.status = m ? 'superseded' : value
      draft.supersededBy = m ? m[1]! : null
      return
    }
    case 'said': {
      const quote = parseQuoted(value)
      if (quote === null) fail('the quote is not in quotation marks')
      const quotedAt = stampToIso(label[2]!)
      if (Number.isNaN(Date.parse(quotedAt))) fail(`the quote time ${label[2]} is not a valid UTC time`)
      draft.saidAs = label[1] ? 'choice' : 'words'
      draft.quote = quote
      draft.quotedAt = quotedAt
      return
    }
    case 'question': {
      if (value === NONE) {
        draft.question = null
        return
      }
      const question = parseQuoted(value)
      if (question === null) fail(`Answering is neither a quoted question nor ${NONE}`)
      draft.question = question
      return
    }
    case 'verified': {
      const text = value ?? ''
      const sp = text.indexOf(' ')
      if (sp <= 0) fail('Verified is not "<level> <reference>"')
      draft.verified = { level: text.slice(0, sp), ref: text.slice(sp + 1) }
      return
    }
    case 'restated':
      if (value !== undefined && value !== NONE) fail(`Restated is neither ${NONE} nor nested bullets`)
      return
    default:
      draft[key] = parseList(value)
  }
}

function parseEntry(lines: string[], file: string): RegisterEntry {
  const heading = lines[0]!
  const header = HEADER_RE.exec(heading)
  const fail = (message: string): never => {
    throw new RegisterFormatError(file, heading, message)
  }
  if (!header) fail('heading is not "## <id> · <subject>"')
  const draft: EntryDraft = {}
  let fieldIdx = 0
  let inRestated = false
  for (const line of lines.slice(1)) {
    if (line === '') continue
    if (inRestated && RESTATED_RE.test(line)) continue
    const bullet = BULLET_RE.exec(line)
    const idx = bullet ? FIELDS.findIndex((f, k) => k >= fieldIdx && f.label.test(bullet[1]!)) : -1
    if (idx < 0) fail(`unexpected line: ${line}`)
    if (idx > fieldIdx) fail(`missing ${FIELDS[fieldIdx]!.key}`)
    const field = FIELDS[idx]!
    applyField(draft, field.key, field.label.exec(bullet![1]!)!, bullet![2], fail)
    inRestated = field.key === 'restated' && bullet![2] === undefined
    fieldIdx = idx + 1
  }
  if (fieldIdx < FIELDS.length) fail(`missing ${FIELDS[fieldIdx]!.key}`)
  return {
    id: header![1]!,
    subject: header![2]!,
    status: draft.status!,
    supersededBy: draft.supersededBy ?? null,
    saidAs: draft.saidAs!,
    quote: draft.quote!,
    quotedAt: draft.quotedAt!,
    question: draft.question ?? null,
    verified: draft.verified!,
    appliesTo: draft.appliesTo ?? [],
    triggers: draft.triggers ?? [],
    supersedes: draft.supersedes ?? [],
    block: lines.join('\n').trimEnd(),
  }
}

/**
 * Parses a register file's entries. The front matter, title and intro before
 * the first entry are not entries and are skipped. A malformed entry throws a
 * `RegisterFormatError` naming the file and the entry's heading.
 */
export function parseRegister(text: string, file: string): RegisterEntry[] {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const entries: RegisterEntry[] = []
  let i = lines.findIndex((l) => l.startsWith('## '))
  if (i < 0) return entries
  while (i < lines.length) {
    let end = i + 1
    while (end < lines.length && !lines[end]!.startsWith('## ')) end += 1
    entries.push(parseEntry(lines.slice(i, end), file))
    i = end
  }
  return entries
}

function toMillis(at: string | Date, what: string): number {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at)
  if (Number.isNaN(ms)) throw new Error(`${what}: ${String(at)} is not a valid time`)
  return ms
}

/**
 * The entries in force at `at`: quoted at or before it, `active` or
 * `superseded`, and not superseded by an entry quoted at or before it. A
 * superseded entry was in force until its successor was given.
 */
export function entriesInForce(entries: readonly RegisterEntry[], at: string | Date): RegisterEntry[] {
  const t = toMillis(at, 'entriesInForce')
  const quotedBy = (e: RegisterEntry) => Date.parse(e.quotedAt) <= t
  const replaced = new Set(entries.filter(quotedBy).flatMap((e) => e.supersedes))
  return entries.filter((e) => (e.status === 'active' || e.status === 'superseded') && quotedBy(e) && !replaced.has(e.id))
}

export interface ProjectRegistry {
  version: 1
  workspaces: Record<string, { root: string; vault_folder: string | null; register_prefix: string | null }>
  projects: Record<string, { workspace: string | null; vault_folder: string | null; register_prefix: string | null }>
}

export type RegisterScope = 'global' | 'project' | 'workspace'

export interface LoadedRegister {
  scope: RegisterScope
  /** `global`, the project's repo name or the workspace id. */
  scopeId: string
  file: string
  entries: RegisterEntry[]
}

export interface RegisterGap {
  scope: RegisterScope
  scopeId: string
  reason: 'not-in-registry' | 'no-vault-folder' | 'missing-file'
  file: string | null
}

export interface RegistersResult {
  registers: LoadedRegister[]
  gaps: RegisterGap[]
}

interface ScopeFolder {
  scope: RegisterScope
  scopeId: string
  folder: string | null
  known: boolean
}

function scopeFolders(c: Pick<DecisionCase, 'project_id' | 'workspace_id' | 'at_root'>, registry: ProjectRegistry): ScopeFolder[] {
  const out: ScopeFolder[] = []
  const project = !c.at_root && c.project_id !== null && Object.hasOwn(registry.projects, c.project_id) ? registry.projects[c.project_id]! : null
  const workspaceId = c.workspace_id ?? project?.workspace ?? null
  const workspace = workspaceId !== null && Object.hasOwn(registry.workspaces, workspaceId) ? registry.workspaces[workspaceId]! : null
  if (!c.at_root && c.project_id !== null) {
    const folder = project ? (project.vault_folder ?? workspace?.vault_folder ?? null) : null
    out.push({ scope: 'project', scopeId: c.project_id, folder, known: project !== null })
  }
  if (workspaceId !== null) {
    out.push({ scope: 'workspace', scopeId: workspaceId, folder: workspace?.vault_folder ?? null, known: workspace !== null })
  }
  return out
}

function loadRegister(scope: RegisterScope, scopeId: string, file: string, gaps: RegisterGap[]): LoadedRegister | null {
  if (!fs.existsSync(file)) {
    gaps.push({ scope, scopeId, reason: 'missing-file', file })
    return null
  }
  return { scope, scopeId, file, entries: parseRegister(fs.readFileSync(file, 'utf8'), file) }
}

/**
 * The registers a case's scope reaches, in order: the global register, the
 * project's register, then its workspace's; at a workspace root, the
 * workspace's alone. A project without its own vault folder shares its
 * workspace's, which is then listed once. A scope missing from the registry, a
 * scope without a vault folder and a missing file are returned as gaps.
 */
export function registersFor(
  c: Pick<DecisionCase, 'project_id' | 'workspace_id' | 'at_root'>,
  registry: ProjectRegistry,
  roots: { dotfiles: string; vaultRoot: string },
): RegistersResult {
  const gaps: RegisterGap[] = []
  const registers: LoadedRegister[] = []
  const add = (r: LoadedRegister | null) => {
    if (r && !registers.some((x) => x.file === r.file)) registers.push(r)
  }
  add(loadRegister('global', 'global', path.join(roots.dotfiles, GLOBAL_REGISTER), gaps))
  for (const s of scopeFolders(c, registry)) {
    if (!s.known) gaps.push({ scope: s.scope, scopeId: s.scopeId, reason: 'not-in-registry', file: null })
    else if (s.folder === null) gaps.push({ scope: s.scope, scopeId: s.scopeId, reason: 'no-vault-folder', file: null })
    else add(loadRegister(s.scope, s.scopeId, path.join(roots.vaultRoot, s.folder, RULINGS_FILE), gaps))
  }
  return { registers, gaps }
}

export interface PlanDecision {
  id: string
  decided: string
  /** One line in the format agents are shown a plan's decisions in. */
  line: string
}

export interface PlanDecisionsResult {
  decisions: PlanDecision[]
  /** Ids of class-A decisions with neither `decided` nor `date`: they cannot be placed in time. */
  undated: string[]
}

interface LedgerDecision {
  id?: unknown
  class?: unknown
  trigger?: unknown
  ruling?: unknown
  decided?: unknown
  date?: unknown
  by?: unknown
  quote?: unknown
  superseded_by?: unknown
}

function oneLine(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * True when a ledger date is at or before `t`. A ledger records most decisions
 * by calendar day only, so a day-only date counts from the start of that UTC
 * day: a decision recorded on the day of the decision is in scope.
 */
function datedBy(value: string, t: number): boolean {
  const ms = Date.parse(DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(ms)) throw new Error(`plan decision date ${value} is not a valid date`)
  return ms <= t
}

function decisionDate(d: LedgerDecision): string | null {
  const value = oneLine(d.decided) || oneLine(d.date)
  return value === '' ? null : value
}

function renderDecision(d: LedgerDecision, decided: string): string {
  const meta = [decided, d.by ? `by ${oneLine(d.by)}` : ''].filter(Boolean).join(', ')
  const quote = oneLine(d.quote) ? ` — MK: "${oneLine(d.quote)}"` : ''
  return `- ${oneLine(d.id)} (${meta}) ${oneLine(d.trigger)}: ${oneLine(d.ruling)}${quote}`
}

/**
 * A plan's class-A decisions in force at `at`, one line each. A decision is in
 * force once its date is reached, until the decision that superseded it is
 * dated at or before `at`.
 */
export function planDecisionsAt(ledgerJson: unknown, at: string | Date): PlanDecisionsResult {
  const t = toMillis(at, 'planDecisionsAt')
  const raw = (ledgerJson as { decisions?: unknown } | null)?.decisions
  const all: LedgerDecision[] = Array.isArray(raw) ? raw.filter((d): d is LedgerDecision => d !== null && typeof d === 'object') : []
  const byId = new Map(all.map((d) => [oneLine(d.id), d]))
  const classA = all.filter((d) => oneLine(d.class).toUpperCase() === 'A' && oneLine(d.ruling) !== '')
  const undated: string[] = []
  const decisions: PlanDecision[] = []
  for (const d of classA) {
    const decided = decisionDate(d)
    if (decided === null) {
      undated.push(oneLine(d.id))
      continue
    }
    if (!datedBy(decided, t)) continue
    const successor = d.superseded_by ? byId.get(oneLine(d.superseded_by)) : undefined
    const successorDate = successor ? decisionDate(successor) : null
    if (successorDate !== null && datedBy(successorDate, t)) continue
    decisions.push({ id: oneLine(d.id), decided, line: renderDecision(d, decided) })
  }
  return { decisions, undated }
}

export interface RuleParagraph {
  /** Path relative to the repository root. */
  path: string
  text: string
}

export interface RulesAt {
  /** The commit read, or null when no commit is at or before the time (or no checkout exists). */
  sha: string | null
  paragraphs: RuleParagraph[]
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
  })
}

/** Seconds precision: git compares commit times in whole seconds, inclusive. */
function gitTime(t: number): string {
  return new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z')
}

function commitAt(repo: string, at: string | Date): string | null {
  const t = toMillis(at, 'commitAt')
  const sha = git(repo, ['rev-list', '-1', `--before=${gitTime(t)}`, 'HEAD']).trim()
  return sha === '' ? null : sha
}

function existingPaths(repo: string, sha: string, paths: string[]): string[] {
  const listed = new Set(git(repo, ['ls-tree', '--name-only', sha, '--', ...paths]).split('\n').filter(Boolean))
  return paths.filter((p) => listed.has(p))
}

/** Paragraphs are separated by blank lines; empty ones are dropped. */
export function splitParagraphs(filePath: string, text: string): RuleParagraph[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => ({ path: filePath, text: p }))
}

function readAt(repo: string, sha: string, paths: string[]): RuleParagraph[] {
  return paths.flatMap((p) => splitParagraphs(p, git(repo, ['show', `${sha}:${p}`])))
}

/**
 * The dotfiles rule files every agent loads, as of the last commit at or
 * before `at`: `claude/CLAUDE.md` and each `claude/rules/common/*.md`.
 */
export function ruleFilesAt(repo: string, at: string | Date): RulesAt {
  const sha = commitAt(repo, at)
  if (sha === null) return { sha: null, paragraphs: [] }
  const rules = git(repo, ['ls-tree', '--name-only', sha, DOTFILES_RULES_DIR])
    .split('\n')
    .filter((p) => p.endsWith('.md'))
    .sort()
  const paths = [...existingPaths(repo, sha, [DOTFILES_CLAUDE]), ...rules]
  return { sha, paragraphs: readAt(repo, sha, paths) }
}

function checkoutRoot(cwd: string): string | null {
  if (!fs.existsSync(cwd)) return null
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim() || null
  } catch {
    return null
  }
}

/**
 * The root `CLAUDE.md` and `AGENTS.md` of the case's checkout as of its last
 * commit at or before `at`. A `cwd` that is not, or is no longer, a git
 * checkout gives no commit and no paragraphs.
 */
export function checkoutRulesAt(cwd: string, at: string | Date): RulesAt {
  const root = checkoutRoot(cwd)
  if (root === null) return { sha: null, paragraphs: [] }
  const sha = commitAt(root, at)
  if (sha === null) return { sha: null, paragraphs: [] }
  return { sha, paragraphs: readAt(root, sha, existingPaths(root, sha, CHECKOUT_RULE_FILES)) }
}
