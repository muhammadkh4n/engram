/**
 * Decision cases, one JSON object per line: a real decision an agent made, the
 * memories it needed at that moment and the memories that would have misled it.
 * The replay rebuilds what reached the agent before `decided_at` and scores
 * each needed memory as delivered or not.
 *
 * Unknown fields are refused at every level: a misspelled `item_id` would
 * otherwise score a needed memory as missed without saying why.
 *
 * A `draft` is a builder's proposal and is never scored. It may hold null where
 * its source record cannot tell (the decision time of a table row, the lane of
 * a fact-check gap) and no needed memory yet; review fills those in. A
 * `reviewed` case is complete; a `dropped` one is kept for the record.
 */

export const CASE_STATUSES = ['draft', 'reviewed', 'dropped'] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]

export const SOURCE_KINDS = ['incident', 'factcheck', 'miss'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export const AGENTS = ['main', 'subagent', 'executor'] as const
export type Agent = (typeof AGENTS)[number]

export const CHANNELS = [
  'prompt',
  'session_start',
  'compaction',
  'subagent_start',
  'agent_dispatch',
  'executor_start',
  'decision_point',
  'hand_recall',
] as const
export type Channel = (typeof CHANNELS)[number]

/** Channels whose context arrived through a recall query; each needs `query_text`. */
export const QUERY_CHANNELS: readonly Channel[] = ['prompt', 'agent_dispatch', 'executor_start', 'hand_recall']

export const NEEDED_KINDS = ['ruling', 'fact', 'procedure', 'finding', 'state'] as const
export type NeededKind = (typeof NEEDED_KINDS)[number]

export const LANES = ['scope', 'decision_point', 'query', 'none', 'state'] as const
export type Lane = (typeof LANES)[number]

/** Decision-point trigger words; `stakeholder-draft:<name>` carries the stakeholder's name. */
export const TRIGGER_WORDS = [
  'plan-authoring',
  'dependency',
  'backend',
  'agent-dispatch',
  'deploy',
  'prod-write',
  'pr-create',
  'merge',
  'env-promotion',
] as const
export const STAKEHOLDER_TRIGGER_PREFIX = 'stakeholder-draft:'

export const QUERY_TEXT_MAX = 2000
export const PRIOR_PROMPTS_MAX = 5

export type PhraseGroups = string[][]

export interface CaseSource {
  kind: SourceKind
  ref: string
}

export interface TranscriptRef {
  file: string
  line: number
}

export interface PriorPrompt {
  text: string
  at: string
}

export interface NeededMemory {
  key: string
  kind: NeededKind
  /** Null only in a draft: the lane is set at review, before any run. */
  expected_lane: Lane | null
  phrases: PhraseGroups
  register_ids: string[]
  item_ids: string[]
  legacy_ids: string[]
}

export interface HarmfulMemory {
  key: string
  phrases: PhraseGroups
  current_phrases: PhraseGroups
  item_ids: string[]
  legacy_ids: string[]
}

export interface CaseAudit {
  classes: string[]
  retrievable_by_that_query: string | null
  context_at_decision: string | null
}

export interface DecisionCase {
  id: string
  source: CaseSource
  status: CaseStatus
  /** Null only in a draft whose source has no decision time. */
  decided_at: string | null
  agent: Agent | null
  channel: Channel | null
  session_id: string | null
  transcript: TranscriptRef | null
  cwd: string | null
  project_id: string | null
  workspace_id: string | null
  at_root: boolean
  plan_dirs: string[]
  query_text: string | null
  prior_prompts: PriorPrompt[]
  decision_kind: string | null
  tool_text: string | null
  expect_contradiction: boolean
  needed: NeededMemory[]
  harmful: HarmfulMemory[]
  audit: CaseAudit | null
  note: string
}

export type CaseSplit = 'calibration' | 'check'

export class CaseFormatError extends Error {
  constructor(lineNo: number, message: string) {
    super(`case line ${lineNo}: ${message}`)
    this.name = 'CaseFormatError'
  }
}

const CASE_FIELDS = [
  'id',
  'source',
  'status',
  'decided_at',
  'agent',
  'channel',
  'session_id',
  'transcript',
  'cwd',
  'project_id',
  'workspace_id',
  'at_root',
  'plan_dirs',
  'query_text',
  'prior_prompts',
  'decision_kind',
  'tool_text',
  'expect_contradiction',
  'needed',
  'harmful',
  'audit',
  'note',
] as const
const SOURCE_FIELDS = ['kind', 'ref'] as const
const TRANSCRIPT_FIELDS = ['file', 'line'] as const
const PRIOR_PROMPT_FIELDS = ['text', 'at'] as const
const NEEDED_FIELDS = ['key', 'kind', 'expected_lane', 'phrases', 'register_ids', 'item_ids', 'legacy_ids'] as const
const HARMFUL_FIELDS = ['key', 'phrases', 'current_phrases', 'item_ids', 'legacy_ids'] as const
const AUDIT_FIELDS = ['classes', 'retrievable_by_that_query', 'context_at_decision'] as const

const OFFSET_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

type Raw = Record<string, unknown>

/** Reports problems with a path into the line (`needed[2].kind`) so a fix needs no search. */
class Ctx {
  constructor(
    readonly lineNo: number,
    readonly path: string,
  ) {}

  at(field: string | number): Ctx {
    const next = typeof field === 'number' ? `${this.path}[${field}]` : this.path === '' ? field : `${this.path}.${field}`
    return new Ctx(this.lineNo, next)
  }

  fail(message: string): never {
    throw new CaseFormatError(this.lineNo, this.path === '' ? message : `${this.path} ${message}`)
  }
}

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function objectWith(value: unknown, fields: readonly string[], ctx: Ctx): Raw {
  if (!isRecord(value)) ctx.fail('must be a JSON object')
  const known = new Set(fields)
  for (const key of Object.keys(value)) {
    if (!known.has(key)) ctx.at(key).fail('is an unknown field')
  }
  for (const field of fields) {
    if (!(field in value)) ctx.at(field).fail('is missing')
  }
  return value
}

function nonEmptyString(value: unknown, ctx: Ctx): string {
  if (!isNonEmptyString(value)) ctx.fail('must be a non-empty string')
  return value
}

function nullableString(value: unknown, ctx: Ctx): string | null {
  if (value === null) return null
  return nonEmptyString(value, ctx)
}

function boolean(value: unknown, ctx: Ctx): boolean {
  if (typeof value !== 'boolean') ctx.fail('must be a boolean')
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], ctx: Ctx): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    ctx.fail(`must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function nullableOneOf<T extends string>(value: unknown, allowed: readonly T[], ctx: Ctx): T | null {
  return value === null ? null : oneOf(value, allowed, ctx)
}

function stringList(value: unknown, ctx: Ctx): string[] {
  if (!Array.isArray(value)) ctx.fail('must be an array of non-empty strings')
  return value.map((v, i) => nonEmptyString(v, ctx.at(i)))
}

function phraseGroups(value: unknown, ctx: Ctx): PhraseGroups {
  if (!Array.isArray(value)) ctx.fail('must be an array of phrase groups')
  return value.map((group, i) => {
    const groupCtx: Ctx = ctx.at(i)
    if (!Array.isArray(group) || group.length === 0) groupCtx.fail('must be a non-empty array of non-empty strings')
    return group.map((p, j) => nonEmptyString(p, groupCtx.at(j)))
  })
}

function offsetTime(value: unknown, ctx: Ctx): string {
  if (typeof value !== 'string' || !OFFSET_TIME_RE.test(value) || Number.isNaN(Date.parse(value))) {
    ctx.fail('must be an ISO-8601 time with an offset')
  }
  return value
}

function parseSource(value: unknown, ctx: Ctx): CaseSource {
  const raw = objectWith(value, SOURCE_FIELDS, ctx)
  return { kind: oneOf(raw['kind'], SOURCE_KINDS, ctx.at('kind')), ref: nonEmptyString(raw['ref'], ctx.at('ref')) }
}

function parseTranscript(value: unknown, ctx: Ctx): TranscriptRef | null {
  if (value === null) return null
  const raw = objectWith(value, TRANSCRIPT_FIELDS, ctx)
  const line = raw['line']
  const lineCtx: Ctx = ctx.at('line')
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) lineCtx.fail('must be a positive integer')
  return { file: nonEmptyString(raw['file'], ctx.at('file')), line }
}

function parsePlanDirs(value: unknown, ctx: Ctx): string[] {
  const dirs = stringList(value, ctx)
  dirs.forEach((dir, i) => {
    if (!dir.startsWith('/')) ctx.at(i).fail('must be an absolute path')
  })
  return dirs
}

function parseQueryText(value: unknown, ctx: Ctx): string | null {
  const text = nullableString(value, ctx)
  if (text !== null && text.length > QUERY_TEXT_MAX) ctx.fail(`is ${text.length} chars; at most ${QUERY_TEXT_MAX}`)
  return text
}

function parsePriorPrompts(value: unknown, ctx: Ctx): PriorPrompt[] {
  if (!Array.isArray(value)) ctx.fail('must be an array')
  if (value.length > PRIOR_PROMPTS_MAX) ctx.fail(`holds ${value.length} prompts; at most ${PRIOR_PROMPTS_MAX}`)
  const prompts = value.map((p, i) => {
    const raw = objectWith(p, PRIOR_PROMPT_FIELDS, ctx.at(i))
    return { text: nonEmptyString(raw['text'], ctx.at(i).at('text')), at: offsetTime(raw['at'], ctx.at(i).at('at')) }
  })
  prompts.forEach((p, i) => {
    if (i > 0 && Date.parse(p.at) < Date.parse(prompts[i - 1]!.at)) ctx.at(i).fail('is older than the prompt before it; oldest first')
  })
  return prompts
}

/** True when `word` is a trigger word; `stakeholder-draft:` needs a name after the colon. */
export function isTriggerWord(word: string): boolean {
  if ((TRIGGER_WORDS as readonly string[]).includes(word)) return true
  return word.startsWith(STAKEHOLDER_TRIGGER_PREFIX) && word.slice(STAKEHOLDER_TRIGGER_PREFIX.length).trim() !== ''
}

function parseDecisionKind(value: unknown, ctx: Ctx): string | null {
  const kind = nullableString(value, ctx)
  if (kind !== null && !isTriggerWord(kind)) {
    ctx.fail(`must be a trigger word (${TRIGGER_WORDS.join(', ')}, or ${STAKEHOLDER_TRIGGER_PREFIX}<name>)`)
  }
  return kind
}

function uniqueKeys(entries: readonly { key: string }[], ctx: Ctx): void {
  const seen = new Set<string>()
  entries.forEach((e, i) => {
    if (seen.has(e.key)) ctx.at(i).at('key').fail(`repeats ${e.key}`)
    seen.add(e.key)
  })
}

function hasMatcher(n: NeededMemory): boolean {
  return n.phrases.length > 0 || n.register_ids.length > 0 || n.item_ids.length > 0 || n.legacy_ids.length > 0
}

function parseNeeded(value: unknown, status: CaseStatus, ctx: Ctx): NeededMemory[] {
  if (!Array.isArray(value)) ctx.fail('must be an array')
  const needed = value.map((v, i) => {
    const c = ctx.at(i)
    const raw = objectWith(v, NEEDED_FIELDS, c)
    const entry: NeededMemory = {
      key: nonEmptyString(raw['key'], c.at('key')),
      kind: oneOf(raw['kind'], NEEDED_KINDS, c.at('kind')),
      expected_lane: nullableOneOf(raw['expected_lane'], LANES, c.at('expected_lane')),
      phrases: phraseGroups(raw['phrases'], c.at('phrases')),
      register_ids: stringList(raw['register_ids'], c.at('register_ids')),
      item_ids: stringList(raw['item_ids'], c.at('item_ids')),
      legacy_ids: stringList(raw['legacy_ids'], c.at('legacy_ids')),
    }
    if (status === 'reviewed') {
      if (entry.expected_lane === null) c.at('expected_lane').fail('must be set once the case is reviewed')
      if (!hasMatcher(entry)) c.fail('needs a phrase group or an id once the case is reviewed')
    }
    return entry
  })
  if (status === 'reviewed' && needed.length === 0) ctx.fail('needs at least one memory once the case is reviewed')
  uniqueKeys(needed, ctx)
  return needed
}

function parseHarmful(value: unknown, ctx: Ctx): HarmfulMemory[] {
  if (!Array.isArray(value)) ctx.fail('must be an array')
  const harmful = value.map((v, i) => {
    const c = ctx.at(i)
    const raw = objectWith(v, HARMFUL_FIELDS, c)
    return {
      key: nonEmptyString(raw['key'], c.at('key')),
      phrases: phraseGroups(raw['phrases'], c.at('phrases')),
      current_phrases: phraseGroups(raw['current_phrases'], c.at('current_phrases')),
      item_ids: stringList(raw['item_ids'], c.at('item_ids')),
      legacy_ids: stringList(raw['legacy_ids'], c.at('legacy_ids')),
    }
  })
  uniqueKeys(harmful, ctx)
  return harmful
}

function verbatimText(value: unknown, ctx: Ctx): string | null {
  if (value !== null && typeof value !== 'string') ctx.fail('must be a string or null')
  return value
}

function parseAudit(value: unknown, ctx: Ctx): CaseAudit | null {
  if (value === null) return null
  const raw = objectWith(value, AUDIT_FIELDS, ctx)
  return {
    classes: stringList(raw['classes'], ctx.at('classes')),
    retrievable_by_that_query: verbatimText(raw['retrievable_by_that_query'], ctx.at('retrievable_by_that_query')),
    context_at_decision: verbatimText(raw['context_at_decision'], ctx.at('context_at_decision')),
  }
}

/** A field a draft may leave null; any other status must set it. */
function requiredUnlessDraft<T>(value: T | null, status: CaseStatus, ctx: Ctx): T | null {
  if (value === null && status !== 'draft') ctx.fail('may be null only in a draft')
  return value
}

function checkChannelFields(c: DecisionCase, ctx: Ctx): void {
  if (c.channel !== null && QUERY_CHANNELS.includes(c.channel) && c.query_text === null) {
    ctx.at('query_text').fail(`is required on channel ${c.channel}`)
  }
  if (c.channel === 'decision_point' && c.decision_kind === null) {
    ctx.at('decision_kind').fail('is required on channel decision_point')
  }
  if (c.expect_contradiction && c.tool_text === null) ctx.at('tool_text').fail('is required when expect_contradiction is set')
}

function checkPriorPromptsPrecede(c: DecisionCase, ctx: Ctx): void {
  if (c.decided_at === null) return
  const decided = Date.parse(c.decided_at)
  c.prior_prompts.forEach((p, i) => {
    if (Date.parse(p.at) >= decided) ctx.at('prior_prompts').at(i).at('at').fail('must be before decided_at')
  })
}

/** Parses and validates one case line; `lineNo` is its 1-based line in the file. */
export function parseCaseLine(text: string, lineNo: number): DecisionCase {
  const ctx: Ctx = new Ctx(lineNo, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    ctx.fail('not valid JSON')
  }
  const raw = objectWith(parsed, CASE_FIELDS, ctx)
  const status = oneOf(raw['status'], CASE_STATUSES, ctx.at('status'))
  const decidedAt = raw['decided_at'] === null ? null : offsetTime(raw['decided_at'], ctx.at('decided_at'))
  const note = raw['note']
  if (typeof note !== 'string') ctx.at('note').fail('must be a string')

  const c: DecisionCase = {
    id: nonEmptyString(raw['id'], ctx.at('id')),
    source: parseSource(raw['source'], ctx.at('source')),
    status,
    decided_at: requiredUnlessDraft(decidedAt, status, ctx.at('decided_at')),
    agent: requiredUnlessDraft(nullableOneOf(raw['agent'], AGENTS, ctx.at('agent')), status, ctx.at('agent')),
    channel: requiredUnlessDraft(nullableOneOf(raw['channel'], CHANNELS, ctx.at('channel')), status, ctx.at('channel')),
    session_id: requiredUnlessDraft(nullableString(raw['session_id'], ctx.at('session_id')), status, ctx.at('session_id')),
    transcript: parseTranscript(raw['transcript'], ctx.at('transcript')),
    cwd: requiredUnlessDraft(nullableString(raw['cwd'], ctx.at('cwd')), status, ctx.at('cwd')),
    project_id: nullableString(raw['project_id'], ctx.at('project_id')),
    workspace_id: nullableString(raw['workspace_id'], ctx.at('workspace_id')),
    at_root: boolean(raw['at_root'], ctx.at('at_root')),
    plan_dirs: parsePlanDirs(raw['plan_dirs'], ctx.at('plan_dirs')),
    query_text: parseQueryText(raw['query_text'], ctx.at('query_text')),
    prior_prompts: parsePriorPrompts(raw['prior_prompts'], ctx.at('prior_prompts')),
    decision_kind: parseDecisionKind(raw['decision_kind'], ctx.at('decision_kind')),
    tool_text: nullableString(raw['tool_text'], ctx.at('tool_text')),
    expect_contradiction: boolean(raw['expect_contradiction'], ctx.at('expect_contradiction')),
    needed: parseNeeded(raw['needed'], status, ctx.at('needed')),
    harmful: parseHarmful(raw['harmful'], ctx.at('harmful')),
    audit: parseAudit(raw['audit'], ctx.at('audit')),
    note: note as string,
  }
  checkChannelFields(c, ctx)
  checkPriorPromptsPrecede(c, ctx)
  return c
}

/** Parses a case JSONL file. Blank lines are skipped; ids must be unique. */
export function parseCases(text: string): DecisionCase[] {
  const cases: DecisionCase[] = []
  const firstLine = new Map<string, number>()
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    const lineNo = i + 1
    const c = parseCaseLine(line, lineNo)
    const seen = firstLine.get(c.id)
    if (seen !== undefined) throw new CaseFormatError(lineNo, `duplicate id ${c.id} (first on line ${seen})`)
    firstLine.set(c.id, lineNo)
    cases.push(c)
  })
  if (cases.length === 0) throw new Error('case file has no case lines')
  return cases
}

export class CaseReviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaseReviewError'
  }
}

/**
 * Refuses a case file that still holds drafts, or a reviewed case whose needed
 * memories lack a lane or anything to match on. Only a file that passes is scored.
 */
export function assertReviewed(cases: readonly DecisionCase[]): void {
  for (const c of cases) {
    if (c.status === 'draft') throw new CaseReviewError(`case ${c.id} is a draft; only reviewed or dropped cases may be scored`)
    if (c.status !== 'reviewed') continue
    if (c.needed.length === 0) throw new CaseReviewError(`case ${c.id} has no needed memory`)
    for (const n of c.needed) {
      if (n.expected_lane === null) throw new CaseReviewError(`case ${c.id} needed ${n.key} has no expected_lane`)
      if (!hasMatcher(n)) throw new CaseReviewError(`case ${c.id} needed ${n.key} has no phrase group or id`)
    }
  }
}

/** `calibration` for a case decided before `cut`, `check` at or after it. */
export function caseSplit(c: Pick<DecisionCase, 'id' | 'decided_at'>, cut: string | Date): CaseSplit {
  if (c.decided_at === null) throw new CaseReviewError(`case ${c.id} has no decided_at`)
  const cutMs = cut instanceof Date ? cut.getTime() : Date.parse(cut)
  if (Number.isNaN(cutMs)) throw new Error('split cut is not a valid time')
  return Date.parse(c.decided_at) < cutMs ? 'calibration' : 'check'
}
