/**
 * memory_ingest: one typed item per call, either an agent's observation (a
 * claim with its evidence) or MK's own words found in what capture stored
 * for his session. Both go through the extraction gate's rules and the link
 * rules, and the write goes through the same database apply as an
 * extraction commit, so identity, restatement and links follow one set of
 * rules. Argument text is never logged.
 */
import { createHash } from 'node:crypto'
import {
  ATTRIBUTION_PATTERNS,
  OBSERVATION_KINDS,
  STATEMENT_KINDS,
  SUBJECT_LABEL_MAX_CHARS,
  SUBJECT_LABEL_MIN_CHARS,
  buildWindow,
  gateWindow,
  generateId,
  isItemConstraintError,
  itemEventKey,
  labelKey,
  normalizeLabel,
  normalizeQuote,
  observationEntities,
  quoteOccursIn,
  scrubSecrets,
  statementEntities,
  validateLinks,
} from '@engram-mem/core'
import type {
  ExtractionEntity,
  ExtractionItem,
  ExtractionNewSubject,
  GatedStatement,
  GatedSubject,
  IngestProject,
  ItemIngestStore,
  LinkProposal,
  LinkSource,
  LinkTarget,
  ProposedEvidence,
  RawWindowUtterance,
  RejectionRule,
  SecretRegistryStatus,
} from '@engram-mem/core'
import { degradedReason } from './capture-events/route.js'

type ToolTextResult = { content: Array<{ type: 'text'; text: string }>; isError?: true }

export const UNTYPED_INGEST_MESSAGE =
  'memory_ingest takes typed input. Observation: {class:"observation", kind, subject, content, evidence:[{type, ref}], ' +
  'project_id?, session_id?}. MK\'s words: {class:"mk_statement", kind, subject, quote, question?, standing?, ' +
  'session_id}. A role/content write is no longer accepted.'

export const INGEST_EVIDENCE_TYPES = ['item', 'commit', 'pr', 'file', 'url'] as const
export const INGEST_SCOPES = ['global', 'workspace', 'project'] as const
export const INGEST_CONTENT_MAX_CHARS = 4000
export const INGEST_QUOTE_MAX_CHARS = 4000
export const INGEST_QUESTION_MAX_CHARS = 2000
export const INGEST_EVIDENCE_MAX = 10
export const INGEST_EVIDENCE_REF_MAX_CHARS = 500
export const INGEST_LINKS_MAX = 10
const ID_MAX_CHARS = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA_PREFIX = /^[0-9a-f]{7,40}$/i
const NEW_SUBJECT_KEY = 'new-1'

type EvidenceType = (typeof INGEST_EVIDENCE_TYPES)[number]
type Scope = (typeof INGEST_SCOPES)[number]

interface Evidence {
  type: EvidenceType
  ref: string
}

interface ObservationInput {
  class: 'observation'
  kind: (typeof OBSERVATION_KINDS)[number]
  subject: string
  content: string
  evidence: Evidence[]
  supersedes: string[]
  projectId: string | null
  sessionId: string | null
}

interface StatementInput {
  class: 'mk_statement'
  kind: (typeof STATEMENT_KINDS)[number]
  subject: string
  quote: string
  question: string | null
  standing: boolean
  scope: Scope | null
  corrects: string[]
  supersedes: string[]
  sessionId: string
}

type IngestInput = ObservationInput | StatementInput
type Refusal = { error: string }

export interface ItemToolDeps {
  store: ItemIngestStore
  /** The secret registry's state; nothing is stored while it is degraded. */
  status: () => SecretRegistryStatus
  /** Masks registered and detected secrets; defaults to the server's registry. */
  scrub?: (text: string) => Promise<string>
  now?: () => Date
}

/** A planned write: the item and the new subject it may name. */
interface IngestPlan {
  item: ExtractionItem
  subjects: ExtractionNewSubject[]
}

const SUBJECT_SCHEMA = {
  type: 'string',
  minLength: SUBJECT_LABEL_MIN_CHARS,
  maxLength: SUBJECT_LABEL_MAX_CHARS,
  description: 'What the item is about, reused across items: an existing label is matched ignoring case.',
}
const ITEM_IDS_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: INGEST_LINKS_MAX,
  items: { type: 'string', format: 'uuid' },
}

export const MEMORY_INGEST_TOOL = {
  name: 'memory_ingest',
  description:
    'Store one typed memory item and get its id. Two forms. ' +
    'An observation is your own claim with evidence: {class:"observation", kind: fact|procedure|finding, subject, ' +
    'content, evidence:[{type: item|commit|pr|file|url, ref}], supersedes?, project_id?, session_id?}. ' +
    "MK's words are an exact quote of what MK wrote earlier in this session: {class:\"mk_statement\", kind: " +
    'ruling|fact|correction, subject, quote, question?, standing?, scope?, corrects?, supersedes?, session_id}. ' +
    'Never write "we decided", "MK wants" or any decision of MK\'s as an observation: quote MK\'s words as an ' +
    'mk_statement instead. Answers JSON: {"id", "outcome": "stored"|"restated"|"duplicate"}.',
  inputSchema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      class: { type: 'string', enum: ['observation', 'mk_statement'] },
      kind: {
        type: 'string',
        enum: [...new Set([...OBSERVATION_KINDS, ...STATEMENT_KINDS])],
        description: 'observation: fact, procedure or finding. mk_statement: ruling, fact or correction.',
      },
      subject: SUBJECT_SCHEMA,
      content: { type: 'string', minLength: 1, maxLength: INGEST_CONTENT_MAX_CHARS, description: 'observation only: the claim.' },
      evidence: {
        type: 'array',
        minItems: 1,
        maxItems: INGEST_EVIDENCE_MAX,
        description: 'observation only. An item or commit ref that resolves makes the claim trust 2.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'ref'],
          properties: {
            type: { type: 'string', enum: [...INGEST_EVIDENCE_TYPES] },
            ref: { type: 'string', minLength: 1, maxLength: INGEST_EVIDENCE_REF_MAX_CHARS },
          },
        },
      },
      quote: {
        type: 'string',
        minLength: 1,
        maxLength: INGEST_QUOTE_MAX_CHARS,
        description: "mk_statement only: MK's exact words from an earlier turn of this session.",
      },
      question: {
        type: 'string',
        minLength: 1,
        maxLength: INGEST_QUESTION_MAX_CHARS,
        description: 'mk_statement only: the exact question MK answered, from the assistant turn before his words or the dialog he answered.',
      },
      standing: { type: 'boolean', description: 'mk_statement only: a rule that keeps applying. Default false.' },
      scope: {
        type: 'string',
        enum: [...INGEST_SCOPES],
        description: "mk_statement only. Default: the narrowest scope MK's utterance has.",
      },
      corrects: { ...ITEM_IDS_SCHEMA, description: 'mk_statement of kind correction only: the items it corrects.' },
      supersedes: { ...ITEM_IDS_SCHEMA, description: 'Current items of the same class and subject this one replaces.' },
      project_id: { type: 'string', description: 'observation only: a registered project id.' },
      session_id: { type: 'string', description: 'Required for mk_statement: the session MK said the words in.' },
    },
    required: ['class', 'kind', 'subject'],
  },
}

export async function runMemoryIngestTyped(deps: ItemToolDeps, args: Record<string, unknown>): Promise<ToolTextResult> {
  if (args['class'] === undefined) return { content: [{ type: 'text', text: UNTYPED_INGEST_MESSAGE }], isError: true }
  const parsed = parseIngestArgs(args)
  if ('error' in parsed) return toolError(parsed.error)
  if (degradedReason(deps.status()) !== null) {
    return toolError("nothing was stored: the server's secret registry is degraded, so secrets could not be masked")
  }
  const input = await scrubInput(parsed, deps.scrub ?? defaultScrub)
  const plan =
    input.class === 'mk_statement'
      ? await planStatement(deps.store, input)
      : await planObservation(deps.store, input, (deps.now ?? (() => new Date()))())
  if ('error' in plan) return toolError(plan.error)
  return writePlan(deps.store, plan)
}

async function defaultScrub(text: string): Promise<string> {
  return (await scrubSecrets(text)).text
}

async function writePlan(store: ItemIngestStore, plan: IngestPlan): Promise<ToolTextResult> {
  try {
    const result = await store.ingestItem({ subjects: plan.subjects, item: plan.item })
    const outcome = result.duplicates > 0 ? 'duplicate' : result.restatements > 0 ? 'restated' : 'stored'
    return toolText(JSON.stringify({ id: result.itemIds[0], outcome }))
  } catch (err) {
    if (isItemConstraintError(err)) return toolError(`nothing was stored: the store refused the item (${err.constraint})`)
    throw err
  }
}

// --- Arguments ------------------------------------------------------------------

const COMMON_FIELDS = ['class', 'kind', 'subject', 'supersedes', 'session_id']
const FIELDS: Record<IngestInput['class'], ReadonlySet<string>> = {
  observation: new Set([...COMMON_FIELDS, 'content', 'evidence', 'project_id']),
  mk_statement: new Set([...COMMON_FIELDS, 'quote', 'question', 'standing', 'scope', 'corrects']),
}
const KNOWN_FIELDS: ReadonlySet<string> = new Set([...FIELDS.observation, ...FIELDS.mk_statement])

function parseIngestArgs(args: Record<string, unknown>): IngestInput | Refusal {
  const itemClass = args['class']
  if (itemClass !== 'observation' && itemClass !== 'mk_statement') {
    return { error: 'class must be "observation" or "mk_statement"' }
  }
  for (const key of Object.keys(args)) {
    if (!KNOWN_FIELDS.has(key)) return { error: `unknown field: ${key.slice(0, 60)}` }
    if (!FIELDS[itemClass].has(key)) return { error: `${key} is not accepted for class ${itemClass}` }
  }
  const subject = subjectArg(args['subject'])
  if (typeof subject !== 'string') return subject
  const supersedes = idsArg(args['supersedes'], 'supersedes')
  if ('error' in supersedes) return supersedes
  const sessionId = optionalText(args['session_id'], 'session_id', ID_MAX_CHARS)
  if (typeof sessionId === 'object' && sessionId !== null) return sessionId
  const common = { subject, supersedes: supersedes.ids }
  return itemClass === 'observation'
    ? parseObservation(args, { ...common, sessionId })
    : parseStatement(args, { ...common, sessionId })
}

type Common = { subject: string; supersedes: string[]; sessionId: string | null }

function parseObservation(args: Record<string, unknown>, common: Common): ObservationInput | Refusal {
  const kind = args['kind']
  if (!isOneOf(kind, OBSERVATION_KINDS)) return { error: `kind must be one of ${OBSERVATION_KINDS.join(', ')} for an observation` }
  const content = requiredText(args['content'], 'content', INGEST_CONTENT_MAX_CHARS)
  if (typeof content !== 'string') return content
  const evidence = evidenceArg(args['evidence'])
  if ('error' in evidence) return evidence
  const projectId = optionalText(args['project_id'], 'project_id', ID_MAX_CHARS)
  if (typeof projectId === 'object' && projectId !== null) return projectId
  return { class: 'observation', kind, content, evidence: evidence.list, projectId, ...common }
}

function parseStatement(args: Record<string, unknown>, common: Common): StatementInput | Refusal {
  const kind = args['kind']
  if (!isOneOf(kind, STATEMENT_KINDS)) return { error: `kind must be one of ${STATEMENT_KINDS.join(', ')} for an mk_statement` }
  if (common.sessionId === null) return { error: 'session_id is required for an mk_statement' }
  const quote = requiredText(args['quote'], 'quote', INGEST_QUOTE_MAX_CHARS)
  if (typeof quote !== 'string') return quote
  const question = optionalText(args['question'], 'question', INGEST_QUESTION_MAX_CHARS)
  if (typeof question === 'object' && question !== null) return question
  const standing = args['standing'] ?? false
  if (typeof standing !== 'boolean') return { error: 'standing must be a boolean' }
  const scope = args['scope'] ?? null
  if (scope !== null && !isOneOf(scope, INGEST_SCOPES)) return { error: `scope must be one of ${INGEST_SCOPES.join(', ')}` }
  const corrects = idsArg(args['corrects'], 'corrects')
  if ('error' in corrects) return corrects
  if (corrects.ids.length > 0 && kind !== 'correction') return { error: 'corrects is accepted only with kind "correction"' }
  return { class: 'mk_statement', kind, quote, question, standing, scope, corrects: corrects.ids, ...common, sessionId: common.sessionId }
}

function subjectArg(value: unknown): string | Refusal {
  if (typeof value !== 'string') return { error: 'subject must be a string' }
  const length = codePoints(normalizeLabel(value))
  if (length < SUBJECT_LABEL_MIN_CHARS || length > SUBJECT_LABEL_MAX_CHARS) {
    return { error: `subject must be ${SUBJECT_LABEL_MIN_CHARS} to ${SUBJECT_LABEL_MAX_CHARS} characters` }
  }
  return normalizeLabel(value)
}

function requiredText(value: unknown, name: string, max: number): string | Refusal {
  if (typeof value !== 'string' || !/\S/.test(value)) return { error: `${name} must be a non-blank string` }
  if (codePoints(value) > max) return { error: `${name} must be at most ${max} characters` }
  return value
}

function optionalText(value: unknown, name: string, max: number): string | null | Refusal {
  return value === undefined ? null : requiredText(value, name, max)
}

function idsArg(value: unknown, name: string): { ids: string[] } | Refusal {
  if (value === undefined) return { ids: [] }
  if (!Array.isArray(value) || value.length < 1 || value.length > INGEST_LINKS_MAX) {
    return { error: `${name} must be an array of 1 to ${INGEST_LINKS_MAX} item ids` }
  }
  if (!value.every((id) => typeof id === 'string' && UUID.test(id))) return { error: `${name} must hold item ids (UUIDs)` }
  return { ids: [...new Set((value as string[]).map((id) => id.toLowerCase()))] }
}

function evidenceArg(value: unknown): { list: Evidence[] } | Refusal {
  const shape = `evidence must be an array of 1 to ${INGEST_EVIDENCE_MAX} {type, ref} entries`
  if (!Array.isArray(value) || value.length < 1 || value.length > INGEST_EVIDENCE_MAX) return { error: shape }
  const list: Evidence[] = []
  for (const entry of value) {
    if (!isRecord(entry) || Object.keys(entry).some((k) => k !== 'type' && k !== 'ref')) return { error: shape }
    if (!isOneOf(entry['type'], INGEST_EVIDENCE_TYPES)) {
      return { error: `evidence type must be one of ${INGEST_EVIDENCE_TYPES.join(', ')}` }
    }
    const ref = requiredText(entry['ref'], 'evidence ref', INGEST_EVIDENCE_REF_MAX_CHARS)
    if (typeof ref !== 'string') return ref
    list.push({ type: entry['type'], ref: ref.trim() })
  }
  return { list }
}

/** Free text is masked before any match or write; ids and enums carry none. */
async function scrubInput(input: IngestInput, scrub: (text: string) => Promise<string>): Promise<IngestInput> {
  const subject = await scrub(input.subject)
  if (input.class === 'mk_statement') {
    const question = input.question === null ? null : await scrub(input.question)
    return { ...input, subject, quote: await scrub(input.quote), question }
  }
  const evidence: Evidence[] = []
  for (const e of input.evidence) evidence.push({ type: e.type, ref: await scrub(e.ref) })
  return { ...input, subject, content: await scrub(input.content), evidence }
}

// --- MK's words -------------------------------------------------------------------

async function planStatement(store: ItemIngestStore, input: StatementInput): Promise<IngestPlan | Refusal> {
  // The store lists the session's utterances newest first, ties by lowest id,
  // so the first one holding the quote is the one the words are taken from.
  const utterance = (await store.sessionMkUtterances(input.sessionId)).find((u) => quoteOccursIn(input.quote, u.content))
  if (utterance === undefined) {
    return {
      error:
        `quote not found in MK's captured words for session ${input.sessionId}. A turn is captured when it ends: ` +
        'quote words from an earlier turn, exactly as MK wrote them.',
    }
  }
  const projects = await store.projectRows()
  const gated = await gateStatement(store, input, utterance, projects)
  if ('error' in gated) return gated
  const subject = await resolveSubject(store, gated.subject)
  const source: LinkSource = {
    index: 0,
    class: 'mk_statement',
    subjectId: subject.subjectId,
    subjectLabel: gated.subject.label,
    occurredAt: gated.occurredAt,
    projectId: utterance.project_id,
    workspaceId: utterance.workspace_id,
  }
  const proposals = [...linkProposals('supersedes', input.supersedes), ...linkProposals('corrects', input.corrects)]
  const links = await checkLinks(source, proposals, proposals.length === 0 ? [] : await store.linkTargets(input.supersedes.concat(input.corrects)))
  if ('error' in links) return links
  return { subjects: subject.subjects, item: { ...statementItem(gated, projects), ...subject.ref, links: links.links } }
}

/**
 * Runs the extraction gate on a window of the matched utterance: for a prompt
 * the assistant turn just before it, for a dialog answer the questions of its
 * capture event, which is where the gate looks for the question MK answered.
 */
async function gateStatement(
  store: ItemIngestStore,
  input: StatementInput,
  utterance: RawWindowUtterance,
  projects: readonly IngestProject[],
): Promise<GatedStatement | Refusal> {
  const isAnswer = utterance.kind === 'user_answer'
  const eventId = utterance.source?.['event_id']
  const payload =
    isAnswer && (typeof eventId === 'string' || typeof eventId === 'number')
      ? await store.captureEventPayload(String(eventId))
      : null
  const turn = isAnswer ? null : await store.assistantTurnBefore(utterance)
  const window = buildWindow({
    anchor: utterance,
    anchor_event: payload === null ? null : { payload },
    turns: turn === null ? [] : [turn],
    projects: projects.map((p) => ({ id: p.id, kind: p.kind })),
  })
  const result = gateWindow(window, {
    ok: true,
    statements: [
      {
        index: 0,
        utteranceId: 'utt-1',
        quote: input.quote,
        question: input.question,
        kind: input.kind,
        standing: input.standing,
        scope: input.scope ?? narrowestScope(utterance),
        subject: { new: input.subject },
        appliesTo: [],
        supersedes: [],
        restates: [],
        corrects: [],
      },
    ],
    observations: [],
    rejected: [],
  })
  return result.statements[0] ?? { error: gateMessage(result.rejected[0]?.rule) }
}

function narrowestScope(utterance: RawWindowUtterance): Scope {
  if (utterance.project_id !== null) return 'project'
  return utterance.workspace_id !== null ? 'workspace' : 'global'
}

function gateMessage(rule: RejectionRule | undefined): string {
  switch (rule) {
    case 'question_not_found':
      return (
        'question not found: quote it exactly from the assistant turn just before MK\'s words, or from the ' +
        'question of the dialog MK answered'
      )
    case 'bad_subject':
      return `subject must be ${SUBJECT_LABEL_MIN_CHARS} to ${SUBJECT_LABEL_MAX_CHARS} characters`
    default:
      return `the extraction gate refused the statement (${rule ?? 'unknown'})`
  }
}

function statementItem(s: GatedStatement, projects: readonly IngestProject[]): Omit<ExtractionItem, 'subjectId' | 'subjectKey'> {
  return {
    id: generateId(),
    class: 'mk_statement',
    kind: s.kind,
    speaker: 'mk',
    trust: 0,
    projectId: s.projectId,
    workspaceId: s.workspaceId,
    planSlug: s.planSlug,
    sessionId: s.sessionId,
    content: s.content,
    searchText: s.context === null ? s.content : `${s.context} — ${s.content}`,
    context: s.context,
    occurredAt: new Date(s.occurredAt),
    standing: s.standing,
    registerStatus: s.standing ? 'candidate' : null,
    source: {
      type: 'ingest_tool',
      utterance_id: s.utteranceId,
      event_key: itemEventKey('mk_statement', s.utteranceId, s.content),
    },
    lineage: [s.utteranceId],
    entities: toEntities(statementEntities(s.content, s.context, projects)),
  }
}

// --- Observations -----------------------------------------------------------------

async function planObservation(store: ItemIngestStore, input: ObservationInput, now: Date): Promise<IngestPlan | Refusal> {
  if (ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(input.content))) {
    return {
      error:
        'the claim attributes a decision or wish to MK, the user or "we". Store MK\'s own words as an mk_statement ' +
        'with his exact quote instead.',
    }
  }
  const projects = await store.projectRows()
  const columns = projectColumns(projects, input.projectId)
  if (columns === null) return { error: `project_id ${input.projectId} is not a registered project` }
  const itemRefs = input.evidence.filter((e) => e.type === 'item' && UUID.test(e.ref)).map((e) => e.ref.toLowerCase())
  const targets = await store.linkTargets([...new Set([...itemRefs, ...input.supersedes])])
  const verified = await verifyEvidence(store, input.evidence, targets)
  const subject = await resolveSubject(store, { kind: 'new', label: input.subject, projectId: columns.projectId })
  const source: LinkSource = {
    index: 0,
    class: 'observation',
    subjectId: subject.subjectId,
    subjectLabel: input.subject,
    occurredAt: now.toISOString(),
    ...columns,
  }
  const links = await checkLinks(source, linkProposals('supersedes', input.supersedes), targets)
  if ('error' in links) return links
  const item: ExtractionItem = {
    ...observationItem(input, columns, projects, now),
    ...subject.ref,
    trust: verified.all ? 2 : 3,
    lineage: verified.lineage,
    links: links.links,
  }
  return { subjects: subject.subjects, item }
}

/**
 * A registered project's own id and workspace; a workspace row files the item
 * at that workspace with no project, as capture does at a workspace root.
 */
function projectColumns(
  projects: readonly IngestProject[],
  projectId: string | null,
): { projectId: string | null; workspaceId: string | null } | null {
  if (projectId === null) return { projectId: null, workspaceId: null }
  const row = projects.find((p) => p.id === projectId)
  if (row === undefined) return null
  return row.kind === 'workspace' ? { projectId: null, workspaceId: row.id } : { projectId: row.id, workspaceId: row.workspaceId }
}

/**
 * An item ref is verified when the item exists and is not forgotten; a commit
 * ref when a stored commit artifact's SHA starts with it. Both become the
 * claim's lineage, so forgetting the evidence forgets the claim. Other types
 * are kept and never verified.
 */
async function verifyEvidence(
  store: ItemIngestStore,
  evidence: readonly Evidence[],
  targets: readonly LinkTarget[],
): Promise<{ all: boolean; lineage: string[] }> {
  const live = new Set(targets.filter((t) => t.forgottenAt === null).map((t) => t.id.toLowerCase()))
  const lineage: string[] = []
  let all = true
  for (const e of evidence) {
    const ids =
      e.type === 'item'
        ? live.has(e.ref.toLowerCase()) ? [e.ref.toLowerCase()] : []
        : e.type === 'commit' && SHA_PREFIX.test(e.ref) ? await store.commitArtifactIds(e.ref) : []
    if (ids.length === 0) all = false
    for (const id of ids) if (!lineage.includes(id)) lineage.push(id)
  }
  return { all, lineage }
}

function observationItem(
  input: ObservationInput,
  columns: { projectId: string | null; workspaceId: string | null },
  projects: readonly IngestProject[],
  now: Date,
): Omit<ExtractionItem, 'subjectId' | 'subjectKey' | 'trust' | 'lineage'> {
  const content = input.content.trim()
  const evidence = input.evidence.map((e) => ({ type: e.type, ref: e.ref }))
  // An item ref has no entity type; the rest are the extraction gate's evidence types.
  const typed = evidence.filter((e): e is ProposedEvidence => e.type !== 'item')
  return {
    id: generateId(),
    class: 'observation',
    kind: input.kind,
    speaker: 'assistant',
    ...columns,
    planSlug: null,
    sessionId: input.sessionId,
    content,
    searchText: `${input.subject}: ${content}`,
    context: null,
    occurredAt: now,
    standing: null,
    registerStatus: null,
    source: {
      type: 'ingest_tool',
      session_id: input.sessionId,
      evidence,
      event_key: observationEventKey(input.sessionId, input.subject, content),
    },
    entities: toEntities(observationEntities(content, typed, projects)),
  }
}

/** `observation:ingest:<session or none>:<sha256 of the subject key, a newline and the normalized claim>`. */
function observationEventKey(sessionId: string | null, subject: string, content: string): string {
  const digest = createHash('sha256')
    .update(`${labelKey(subject)}\n${normalizeQuote(content)}`, 'utf8')
    .digest('hex')
  return `observation:ingest:${sessionId ?? 'none'}:${digest}`
}

// --- Shared ------------------------------------------------------------------------

/**
 * A stored subject with this label under the item's project is reused, so
 * the link rules compare subject ids; otherwise the write creates it (and its
 * upsert on the label index still reuses one stored meanwhile).
 */
async function resolveSubject(
  store: ItemIngestStore,
  subject: GatedSubject,
): Promise<{ subjectId: string | null; ref: Pick<ExtractionItem, 'subjectId' | 'subjectKey'>; subjects: ExtractionNewSubject[] }> {
  if (subject.kind === 'listed') return { subjectId: subject.id, ref: { subjectId: subject.id, subjectKey: null }, subjects: [] }
  const id = await store.subjectIdByLabel(subject.projectId, subject.label)
  if (id !== null) return { subjectId: id, ref: { subjectId: id, subjectKey: null }, subjects: [] }
  return {
    subjectId: null,
    ref: { subjectId: null, subjectKey: NEW_SUBJECT_KEY },
    subjects: [{ key: NEW_SUBJECT_KEY, projectId: subject.projectId, label: subject.label }],
  }
}

function linkProposals(rel: 'supersedes' | 'corrects', targets: readonly string[]): LinkProposal[] {
  return targets.map((target) => ({ item: 0, rel, target }))
}

/** The caller asked for every link, so one the rules refuse refuses the call. */
async function checkLinks(
  source: LinkSource,
  proposals: readonly LinkProposal[],
  targets: readonly LinkTarget[],
): Promise<{ links: Array<{ rel: LinkProposal['rel']; target: string }> } | Refusal> {
  const { accepted, rejected } = validateLinks([source], proposals, targets)
  const first = rejected[0]
  if (first !== undefined) return { error: `${first.rel} ${first.target} refused: ${first.reason}` }
  return { links: accepted.map((l) => ({ rel: l.rel, target: l.target })) }
}

function toEntities(found: ReadonlyArray<{ entity: string; entity_type: ExtractionEntity['entityType'] }>): ExtractionEntity[] {
  return found.map((e) => ({ entity: e.entity, entityType: e.entity_type }))
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function codePoints(text: string): number {
  return [...text].length
}

function toolText(text: string): ToolTextResult {
  return { content: [{ type: 'text' as const, text }] }
}

function toolError(message: string): ToolTextResult {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}
