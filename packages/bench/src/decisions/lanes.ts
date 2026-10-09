/**
 * The lanes through which memory reached a deciding agent, replayed for one
 * case as of its decision time, in one of two arms.
 *
 * - new: the rule files, the standing-rulings register entries and plan
 *   decisions in force (scope); the entries a decision's kind triggers, or
 *   whose applies-to tokens appear in the text being written (decision
 *   point); and `POST /recall` with `as_of` (query).
 * - old: the rule files alone (scope), and the old recall pipeline over a
 *   frozen snapshot (query). The old system had no decision-point trigger.
 *
 * Every lane item carries `text`, the unit a phrase group must match within,
 * and the source a reader needs to trust it: path and commit for a rule-file
 * paragraph, register file and entry id for an entry, plan folder and
 * decision id for a plan decision, the item's own provenance for a recall.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { PostgrestClient } from '@supabase/postgrest-js'
import type { EvalRecall, EvalStack } from '../eval/eval-stack.js'
import { sha256 } from '../replay/replay-lib.js'
import {
  checkoutRulesAt,
  entriesInForce,
  planDecisionsAt,
  registersFor,
  ruleFilesAt,
  type LoadedRegister,
  type ProjectRegistry,
  type RegisterEntry,
  type RegisterGap,
  type RegisterScope,
  type RulesAt,
} from './as-of.js'
import { QUERY_CHANNELS, type Channel, type DecisionCase } from './cases.js'
import { cutQueryText } from './draft.js'
import {
  RECALL_CHANNELS,
  RECALL_DEFAULT_BUDGET_CHARS,
  RECALL_RANGES,
  RecallStopError,
  assertReplayStoreUrl,
  type RecallChannel,
  type RecallItem,
  type RecallRequest,
  type RecallResponse,
  type RecallScope,
} from './recall-client.js'

export type Arm = 'new' | 'old'

/** The case channels the old pipeline recalled for: MK's prompts and a hand-run recall. */
export const OLD_ARM_QUERY_CHANNELS: readonly Channel[] = ['prompt', 'hand_recall']

/** The tables the old pipeline's items come from; each id's creation time is read from them. */
export const MEMORY_TABLES = ['memory_episodes', 'memory_digests', 'memory_semantic', 'memory_procedural'] as const

const CREATED_AT_BATCH = 100
const PLAN_DECISIONS_FILE = 'ledger.json'

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireDecidedAt(c: DecisionCase): string {
  if (c.decided_at === null) throw new Error(`case ${c.id} has no decided_at; only reviewed cases are replayed`)
  return c.decided_at
}

// ── Channel profiles ─────────────────────────────────────────────────────

/** The request fields `/recall` gets for one case channel. */
export interface ChannelProfile {
  classes?: string[]
  limit?: number
  max_chars?: number
  budget_chars?: number
  include_history?: boolean
  /** Send the case's own session as `exclude_session_id`. */
  exclude_live_session?: boolean
}

export interface ChannelProfiles {
  profiles: Readonly<Partial<Record<Channel, ChannelProfile>>>
  /** Of the profile file's text, for the run's meta. */
  sha256: string
}

/** A profile file the replay cannot use; the CLI reports it as a usage error. */
export class ChannelProfileError extends Error {
  constructor(message: string) {
    super(`channel profiles: ${message}`)
    this.name = 'ChannelProfileError'
  }
}

const PROFILE_KEYS = ['classes', 'limit', 'max_chars', 'budget_chars', 'include_history', 'exclude_live_session']

function rangedInt(raw: Json, key: keyof typeof RECALL_RANGES, where: string): number | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  const { min, max } = RECALL_RANGES[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ChannelProfileError(`${where}.${key} must be an integer from ${min} to ${max}`)
  }
  return value
}

function optionalBool(raw: Json, key: string, where: string): boolean | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new ChannelProfileError(`${where}.${key} must be true or false`)
  return value
}

function parseProfile(raw: unknown, where: string): ChannelProfile {
  if (!isObject(raw)) throw new ChannelProfileError(`${where} is not an object`)
  const unknown = Object.keys(raw).filter((k) => !PROFILE_KEYS.includes(k))
  if (unknown.length > 0) throw new ChannelProfileError(`${where} has unknown field ${unknown[0]}`)
  const classes = raw['classes']
  if (classes !== undefined && (!Array.isArray(classes) || !classes.every((x) => typeof x === 'string' && x !== ''))) {
    throw new ChannelProfileError(`${where}.classes must be a list of class names`)
  }
  const fields: ChannelProfile = {
    classes: classes === undefined ? undefined : [...(classes as string[])],
    limit: rangedInt(raw, 'limit', where),
    max_chars: rangedInt(raw, 'max_chars', where),
    budget_chars: rangedInt(raw, 'budget_chars', where),
    include_history: optionalBool(raw, 'include_history', where),
    exclude_live_session: optionalBool(raw, 'exclude_live_session', where),
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as ChannelProfile
}

/** A JSON object keyed by every query-lane case channel, and nothing else. */
export function parseChannelProfiles(text: string): ChannelProfiles {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ChannelProfileError('not valid JSON')
  }
  if (!isObject(raw)) throw new ChannelProfileError('not a JSON object keyed by channel')
  const extra = Object.keys(raw).filter((k) => !QUERY_CHANNELS.includes(k as Channel))
  if (extra.length > 0) throw new ChannelProfileError(`${extra[0]} is not a query-lane channel`)
  const profiles: Partial<Record<Channel, ChannelProfile>> = {}
  for (const channel of QUERY_CHANNELS) {
    if (!Object.hasOwn(raw, channel)) throw new ChannelProfileError(`no profile for channel ${channel}`)
    profiles[channel] = parseProfile(raw[channel], channel)
  }
  return { profiles, sha256: sha256(text) }
}

// ── Scope lane ───────────────────────────────────────────────────────────

export interface ScopeRoots {
  dotfiles: string
  vaultRoot: string
  registry: ProjectRegistry
}

export interface RuleParagraphItem {
  form: 'rule_paragraph'
  id: null
  text: string
  origin: 'dotfiles' | 'checkout'
  path: string
  sha: string
}

export interface RegisterEntryItem {
  form: 'register_entry'
  id: string
  /** The entry's whole markdown block. */
  text: string
  file: string
  scope: RegisterScope
  scope_id: string
  status: string
  quoted_at: string
  verified: { level: string; ref: string }
}

export interface PlanDecisionItem {
  form: 'plan_decision'
  id: string
  text: string
  plan_dir: string
  decided: string
}

export type ScopeItem = RuleParagraphItem | RegisterEntryItem | PlanDecisionItem

export type ScopeGap =
  | { kind: 'register'; scope: RegisterScope; scope_id: string; reason: RegisterGap['reason']; file: string | null }
  | { kind: 'rule-files'; origin: 'dotfiles' | 'checkout'; path: string | null; reason: 'no-commit' }
  | { kind: 'plan-ledger'; plan_dir: string; reason: 'missing-file' }
  | { kind: 'plan-undated'; plan_dir: string; ids: string[] }

export interface ScopeLane {
  items: ScopeItem[]
  dotfiles_sha: string | null
  checkout_sha: string | null
  registers: { scope: RegisterScope; scope_id: string; file: string }[]
  gaps: ScopeGap[]
}

export interface InForceRegister {
  register: LoadedRegister
  entries: RegisterEntry[]
}

export interface RegistersInForce {
  registers: InForceRegister[]
  gaps: ScopeGap[]
}

/** The case's registers in scope order, each cut to the entries in force at `decided_at`. */
export function registersInForce(c: DecisionCase, roots: ScopeRoots): RegistersInForce {
  const at = requireDecidedAt(c)
  const loaded = registersFor(c, roots.registry, { dotfiles: roots.dotfiles, vaultRoot: roots.vaultRoot })
  return {
    registers: loaded.registers.map((register) => ({ register, entries: entriesInForce(register.entries, at) })),
    gaps: loaded.gaps.map((g) => ({ kind: 'register', scope: g.scope, scope_id: g.scopeId, reason: g.reason, file: g.file })),
  }
}

function ruleItems(rules: RulesAt, origin: RuleParagraphItem['origin']): RuleParagraphItem[] {
  const sha = rules.sha
  if (sha === null) return []
  return rules.paragraphs.map((p) => ({ form: 'rule_paragraph', id: null, text: p.text, origin, path: p.path, sha }))
}

function entryItem(register: LoadedRegister, e: RegisterEntry): RegisterEntryItem {
  return {
    form: 'register_entry',
    id: e.id,
    text: e.block,
    file: register.file,
    scope: register.scope,
    scope_id: register.scopeId,
    status: e.status,
    quoted_at: e.quotedAt,
    verified: { ...e.verified },
  }
}

function planItems(planDir: string, at: string, gaps: ScopeGap[]): PlanDecisionItem[] {
  const file = path.join(planDir, PLAN_DECISIONS_FILE)
  if (!fs.existsSync(file)) {
    gaps.push({ kind: 'plan-ledger', plan_dir: planDir, reason: 'missing-file' })
    return []
  }
  let ledger: unknown
  try {
    ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  const result = planDecisionsAt(ledger, at)
  if (result.undated.length > 0) gaps.push({ kind: 'plan-undated', plan_dir: planDir, ids: result.undated })
  return result.decisions.map((d) => ({ form: 'plan_decision', id: d.id, text: d.line, plan_dir: planDir, decided: d.decided }))
}

/**
 * The scope lane as of `decided_at`. Both arms get the dotfiles rule files and
 * the root rule files of the case's checkout; given the registers in force,
 * the new arm adds their entries and the class-A decisions of each plan folder.
 */
export function scopeLane(c: DecisionCase, roots: ScopeRoots, registers?: RegistersInForce): ScopeLane {
  const at = requireDecidedAt(c)
  const gaps: ScopeGap[] = []
  const dotfiles = ruleFilesAt(roots.dotfiles, at)
  if (dotfiles.sha === null) gaps.push({ kind: 'rule-files', origin: 'dotfiles', path: roots.dotfiles, reason: 'no-commit' })
  const checkout = c.cwd === null ? { sha: null, paragraphs: [] } : checkoutRulesAt(c.cwd, at)
  if (checkout.sha === null) gaps.push({ kind: 'rule-files', origin: 'checkout', path: c.cwd, reason: 'no-commit' })
  const items: ScopeItem[] = [...ruleItems(dotfiles, 'dotfiles'), ...ruleItems(checkout, 'checkout')]
  if (registers) {
    gaps.push(...registers.gaps)
    for (const { register, entries } of registers.registers) items.push(...entries.map((e) => entryItem(register, e)))
    for (const planDir of c.plan_dirs) items.push(...planItems(planDir, at, gaps))
  }
  return {
    items,
    dotfiles_sha: dotfiles.sha,
    checkout_sha: checkout.sha,
    registers: (registers?.registers ?? []).map(({ register: r }) => ({ scope: r.scope, scope_id: r.scopeId, file: r.file })),
    gaps,
  }
}

// ── Decision-point lane ──────────────────────────────────────────────────

export interface DecisionPointItem extends RegisterEntryItem {
  matched_by: ('trigger' | 'applies_to')[]
}

export interface ContradictionHit {
  entry_id: string
  file: string
  tokens: string[]
}

export interface DecisionPointLane {
  decision_kind: string
  items: DecisionPointItem[]
  contradiction_hits: ContradictionHit[]
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Case-insensitive whole-word match; a token's own punctuation (`.env`) is part of the word. */
function hasWholeWord(text: string, token: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(token)}(?![\\p{L}\\p{N}_])`, 'iu').test(text)
}

/**
 * The decision-point lane of a `decision_point` case: in-force entries whose
 * triggers name the decision's kind (`stakeholder-draft:<name>` matches that
 * name only), and the contradiction check, which lists in-force entries with
 * an applies-to token in the text being written. Both reach the agent, so
 * both are lane items.
 */
export function decisionPointLane(c: DecisionCase, registers: RegistersInForce): DecisionPointLane | null {
  if (c.channel !== 'decision_point' || c.decision_kind === null) return null
  const kind = c.decision_kind.trim().toLowerCase()
  const items: DecisionPointItem[] = []
  const hits: ContradictionHit[] = []
  for (const { register, entries } of registers.registers) {
    for (const e of entries) {
      const byTrigger = e.triggers.some((t) => t.trim().toLowerCase() === kind)
      const toolText = c.tool_text
      const tokens = toolText === null ? [] : e.appliesTo.filter((t) => t.trim() !== '' && hasWholeWord(toolText, t.trim()))
      if (tokens.length > 0) hits.push({ entry_id: e.id, file: register.file, tokens })
      const matchedBy: DecisionPointItem['matched_by'] = [...(byTrigger ? ['trigger' as const] : []), ...(tokens.length > 0 ? ['applies_to' as const] : [])]
      if (matchedBy.length > 0) items.push({ ...entryItem(register, e), matched_by: matchedBy })
    }
  }
  return { decision_kind: c.decision_kind, items, contradiction_hits: hits }
}

// ── Query lane ───────────────────────────────────────────────────────────

export interface QueryInput {
  input: 'query_text' | 'prior_prompt'
  /** The prior prompt's position in the case; 0 for `query_text`. */
  index: number
  text: string
  /** The time the recall is made as of: `decided_at`, or the prior prompt's own time. */
  at: string
  channel: Channel
}

/**
 * What a case's query lane recalls, oldest first. Only the query-lane
 * channels have one. The new arm recalls `query_text` under the case's
 * channel; the old pipeline recalled it only for a prompt or a hand-run
 * recall. Both recall a main agent's prior prompts, each under `prompt`; a
 * subagent or executor never saw MK's prompts. Texts over the route's query
 * limit are cut to their head and tail.
 */
export function queryInputs(c: DecisionCase, arm: Arm): QueryInput[] {
  if (c.channel === null || !QUERY_CHANNELS.includes(c.channel)) return []
  const decidedAt = requireDecidedAt(c)
  const prior: QueryInput[] =
    c.agent === 'main'
      ? c.prior_prompts.map((p, index) => ({ input: 'prior_prompt', index, text: cutQueryText(p.text), at: p.at, channel: 'prompt' }))
      : []
  const servesQuery = arm === 'new' || OLD_ARM_QUERY_CHANNELS.includes(c.channel)
  const own: QueryInput[] =
    servesQuery && c.query_text !== null
      ? [{ input: 'query_text', index: 0, text: cutQueryText(c.query_text), at: decidedAt, channel: c.channel }]
      : []
  return [...prior, ...own]
}

export interface QueryRequestRecord {
  input: QueryInput['input']
  index: number
  at: string
  channel: Channel
  /** The request's character budget (the route's default when the profile names none); null in the old arm. */
  budget_chars: number | null
  /** New arm: item text plus question, summed; old arm: the formatted payload's length. */
  payload_chars: number
  items: number
  omitted: Record<string, unknown> | null
}

export type NewQueryItem = Omit<RecallItem, 'text' | 'question'> & {
  form: 'recall_item'
  /** Index into the lane's `requests`. */
  request: number
  /** The item's text, then its question on its own line. */
  text: string
}

export interface NewQueryLane {
  arm: 'new'
  requests: QueryRequestRecord[]
  items: NewQueryItem[]
}

export interface OldQueryItem {
  form: 'old_recall_item'
  request: number
  id: string | null
  section: string
  text: string
  created_at: string | null
  /** Created after the prompt's time: shown by the snapshot, but the agent could not have seen it. */
  future: boolean
}

export interface OldQueryLane {
  arm: 'old'
  requests: QueryRequestRecord[]
  items: OldQueryItem[]
  future_items: number
  /** Payload ids with no row in the snapshot's memory tables: their creation time is unknown. */
  undated_ids: string[]
}

export interface RecallPoster {
  recall(request: RecallRequest): Promise<RecallResponse>
}

function isRecallChannel(channel: Channel): channel is Channel & RecallChannel {
  return (RECALL_CHANNELS as readonly string[]).includes(channel)
}

/** Scope from the case: no project at a workspace root; plan slugs are the plan folders' basenames. */
export function recallScope(c: DecisionCase): RecallScope {
  const slugs = c.plan_dirs.map((d) => path.basename(d.replace(/[\\/]+$/, '')))
  return {
    ...(!c.at_root && c.project_id !== null ? { project_id: c.project_id } : {}),
    ...(c.workspace_id !== null ? { workspace_id: c.workspace_id } : {}),
    ...(slugs.length > 0 ? { plan_slugs: slugs } : {}),
    ...(c.at_root ? { at_root: true as const } : {}),
  }
}

export function recallRequestFor(c: DecisionCase, input: QueryInput, profiles: ChannelProfiles): RecallRequest {
  const profile = profiles.profiles[input.channel]
  if (profile === undefined) throw new ChannelProfileError(`no profile for channel ${input.channel}`)
  if (!isRecallChannel(input.channel)) throw new Error(`channel ${input.channel} has no recall route`)
  return {
    query: input.text,
    scope: recallScope(c),
    channel: input.channel,
    as_of: input.at,
    ...(profile.classes !== undefined ? { classes: [...profile.classes] } : {}),
    ...(profile.limit !== undefined ? { limit: profile.limit } : {}),
    ...(profile.max_chars !== undefined ? { max_chars: profile.max_chars } : {}),
    ...(profile.budget_chars !== undefined ? { budget_chars: profile.budget_chars } : {}),
    ...(profile.include_history !== undefined ? { include_history: profile.include_history } : {}),
    ...(profile.exclude_live_session === true && c.session_id !== null ? { exclude_session_id: c.session_id } : {}),
  }
}

/** The new arm's query lane: one `/recall` per query input, in order. Null for a channel without one. */
export async function newQueryLane(c: DecisionCase, client: RecallPoster, profiles: ChannelProfiles): Promise<NewQueryLane | null> {
  const inputs = queryInputs(c, 'new')
  if (inputs.length === 0) return null
  const requests: QueryRequestRecord[] = []
  const items: NewQueryItem[] = []
  for (const [request, input] of inputs.entries()) {
    const body = recallRequestFor(c, input, profiles)
    const res = await client.recall(body)
    let chars = 0
    for (const { text, question, ...rest } of res.items) {
      chars += text.length + (question?.length ?? 0)
      items.push({ form: 'recall_item', request, ...rest, text: question ? `${text}\n${question}` : text })
    }
    requests.push({
      input: input.input,
      index: input.index,
      at: input.at,
      channel: input.channel,
      budget_chars: body.budget_chars ?? RECALL_DEFAULT_BUDGET_CHARS,
      payload_chars: chars,
      items: res.items.length,
      omitted: res.omitted,
    })
  }
  return { arm: 'new', requests, items }
}

export type OldRecaller = Pick<EvalStack, 'recall'>

/** Creation times by id, from the snapshot the old pipeline reads; an id without a row is absent. */
export type CreatedAtLookup = (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>

/**
 * The old arm's query lane: the old recall pipeline for each query input,
 * with the case's project (none at a workspace root) and `now` at the
 * prompt's time. An item created after that time is flagged `future`.
 */
export async function oldQueryLane(c: DecisionCase, stack: OldRecaller, createdAt: CreatedAtLookup): Promise<OldQueryLane | null> {
  const inputs = queryInputs(c, 'old')
  if (inputs.length === 0) return null
  const args = !c.at_root && c.project_id !== null ? { project_id: c.project_id } : {}
  const recalls: { input: QueryInput; recall: EvalRecall }[] = []
  for (const input of inputs) {
    const recall = await stack.recall(input.text, args, new Date(input.at))
    if (recall.degraded !== null) {
      throw new RecallStopError('degraded', 'the old recall answered degraded; a degraded recall is not the system under test')
    }
    recalls.push({ input, recall })
  }
  const ids = [...new Set(recalls.flatMap((r) => r.recall.items.flatMap((i) => (i.id === null ? [] : [i.id]))))].sort()
  const created = ids.length > 0 ? await createdAt(ids) : new Map<string, string>()
  const requests: QueryRequestRecord[] = []
  const items: OldQueryItem[] = []
  for (const [request, { input, recall }] of recalls.entries()) {
    const atMs = Date.parse(input.at)
    for (const it of recall.items) {
      const createdAtValue = it.id === null ? null : (created.get(it.id) ?? null)
      const future = createdAtValue !== null && Date.parse(createdAtValue) > atMs
      items.push({ form: 'old_recall_item', request, id: it.id, section: it.section, text: it.line, created_at: createdAtValue, future })
    }
    requests.push({
      input: input.input,
      index: input.index,
      at: input.at,
      channel: input.channel,
      budget_chars: null,
      payload_chars: recall.formatted.length,
      items: recall.items.length,
      omitted: null,
    })
  }
  return {
    arm: 'old',
    requests,
    items,
    future_items: items.filter((i) => i.future).length,
    undated_ids: ids.filter((id) => !created.has(id)),
  }
}

/**
 * Creation times read from the snapshot's PostgREST: `GET /<table>?select=id,created_at&id=in.(…)`
 * over the four memory tables, with the env file's URL and key. Reads only.
 */
export function postgrestCreatedAt(opts: { url: string; key: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch }): CreatedAtLookup {
  assertReplayStoreUrl(opts.url, opts.env ?? process.env)
  const client = new PostgrestClient(opts.url, {
    headers: { Authorization: `Bearer ${opts.key}`, apikey: opts.key },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })
  return async (ids) => {
    const found = new Map<string, string>()
    for (const table of MEMORY_TABLES) {
      const missing = ids.filter((id) => !found.has(id))
      for (let i = 0; i < missing.length; i += CREATED_AT_BATCH) {
        const batch = missing.slice(i, i + CREATED_AT_BATCH)
        const { data, error } = await client.from(table).select('id,created_at').in('id', batch)
        if (error) throw new Error(`reading created_at from ${table} failed: ${error.message}`)
        for (const row of (data ?? []) as unknown[]) {
          if (!isObject(row) || typeof row['id'] !== 'string' || typeof row['created_at'] !== 'string' || Number.isNaN(Date.parse(row['created_at']))) {
            throw new Error(`${table} returned a row without a string id and a valid created_at`)
          }
          if (!found.has(row['id'])) found.set(row['id'], row['created_at'])
        }
      }
    }
    return found
  }
}

// ── One case ─────────────────────────────────────────────────────────────

export interface CaseLanes {
  case_id: string
  arm: Arm
  scope: ScopeLane
  decision_point: DecisionPointLane | null
  query: NewQueryLane | OldQueryLane | null
}

export type ArmDeps =
  | { arm: 'new'; recall: RecallPoster; profiles: ChannelProfiles }
  | { arm: 'old'; stack: OldRecaller; createdAt: CreatedAtLookup }

/** Every lane of one case in one arm. */
export async function replayCase(c: DecisionCase, roots: ScopeRoots, deps: ArmDeps): Promise<CaseLanes> {
  if (deps.arm === 'new') {
    const registers = registersInForce(c, roots)
    return {
      case_id: c.id,
      arm: 'new',
      scope: scopeLane(c, roots, registers),
      decision_point: decisionPointLane(c, registers),
      query: await newQueryLane(c, deps.recall, deps.profiles),
    }
  }
  return {
    case_id: c.id,
    arm: 'old',
    scope: scopeLane(c, roots),
    decision_point: null,
    query: await oldQueryLane(c, deps.stack, deps.createdAt),
  }
}
