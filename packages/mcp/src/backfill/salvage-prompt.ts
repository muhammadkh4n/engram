/**
 * The legacy salvage prompt: one session's old memory rows go to the model,
 * which proposes durable knowledge as observations that cite the rows by
 * number and quote the words that state them. The model only proposes; the
 * salvage gate decides.
 *
 * Any change to the prompt or the reply schema below must come with a new
 * SALVAGE_VERSION: runs and window keys carry the version, so a changed prompt
 * under an old version would make a completed window look done for a prompt
 * it never ran with. The version test pins the sha256 of both.
 */
import {
  extractJsonReply,
  OBSERVATION_KINDS,
  type ObservationKind,
  SUBJECT_LABEL_MAX_CHARS,
  SUBJECT_LISTING_LIMIT,
} from '@engram-mem/core'

export const SALVAGE_VERSION = 'legacy-salvage-v2'
/** Names the call site in logs; never sent to the model. */
export const SALVAGE_LABEL = 'legacy-salvage'
/** A window's rendered rows, newline separators included, in code points. */
export const SALVAGE_WINDOW_MAX_CHARS = 24_000
/** Current salvage observations each window's prompt lists. */
export const SALVAGE_OBSERVATION_LISTING = 20
export const SALVAGE_CLAIM_MIN_CHARS = 1
export const SALVAGE_CLAIM_MAX_CHARS = 1000
export const SALVAGE_QUOTE_MIN_CHARS = 1
export const SALVAGE_QUOTE_MAX_CHARS = 400
export const SALVAGE_EVIDENCE_MIN = 1
export const SALVAGE_EVIDENCE_MAX = 10
/** Observations one reply may propose; the items after them are schema rejections. */
export const SALVAGE_REPLY_MAX_ITEMS = 40
/** The listing's aliases: subjects `subj-N`, observations `obs-N`, from 1. */
export const SUBJECT_ALIAS_PREFIX = 'subj-'
export const OBSERVATION_ALIAS_PREFIX = 'obs-'

/** Rows are numbered from 1. */
const ROW_NUMBER_MIN = 1
/** A window of n rows renders at least n characters, so no row number exceeds its character budget. */
const ROW_NUMBER_MAX = SALVAGE_WINDOW_MAX_CHARS
const SUBJECT_ALIAS_MAX_CHARS = `${SUBJECT_ALIAS_PREFIX}${SUBJECT_LISTING_LIMIT}`.length
const OBSERVATION_ALIAS_MAX_CHARS = `${OBSERVATION_ALIAS_PREFIX}${SALVAGE_OBSERVATION_LISTING}`.length

export const SALVAGE_SYSTEM_PROMPT = `You read rows from an old memory store and propose the durable knowledge they hold, as observations. Code checks
every observation; one that breaks a rule below is discarded.

ROWS are one session's records, oldest first, each one line: "[n] <date time> <label>: <text>".
- assistant: what the AI assistant wrote.
- system: a record a tool or hook wrote.
- digest: an old model-written summary of part of the session.
- fact: a fact an old model took from a digest.
- user: MK's prompt as an old model rewrote it, not his words. It is context only: an observation that cites a user
  row must also cite a row that is not a user row, never quotes a user row, and never takes a decision, wish or
  preference from it.

SUBJECTS lists subjects already in use; OBSERVATIONS lists observations earlier windows stored. A listed observation is
context for supersedes only and never a source: propose only what the rows themselves state, and never quote a listed
observation.

An observation is durable knowledge a later session can use: how code, a system or a tool is; a procedure that
worked; what an investigation established.
- claim: one standalone sentence of at most ${SALVAGE_CLAIM_MAX_CHARS} characters that a reader who never saw the session understands.
  Name the repository, file, system or ticket; resolve "it", "the PR" and "this". No hedging.
- quote: the exact words, ${SALVAGE_QUOTE_MIN_CHARS} to ${SALVAGE_QUOTE_MAX_CHARS} characters, copied from one cited row that is not a user row,
  that state the claim. The claim must follow from the quote; a row that only touches the topic does not show it.
- Never narrate progress or steps ("I read the file", "the assistant ran the tests", "next we will ..."), and skip
  plans and proposals the rows do not show carried out.
- Never attribute a decision, wish or preference to MK, to the user or to "we" ("MK decided", "we agreed", "the user
  wants"). State the knowledge itself: not "We decided to use Postgres" but "The store runs on Postgres".
- kind: "fact" (how something is), "procedure" (how to do something) or "finding" (what an investigation
  established).
- evidence: the row numbers n that show the claim, ${SALVAGE_EVIDENCE_MIN} to ${SALVAGE_EVIDENCE_MAX} of them, the quoted row among them.
- subject: what it is about, as a short noun phrase. Reuse a listed subject {"id": "subj-N"} of the project the cited
  rows belong to when one fits; give {"new": "<label>"} only when none does.
- supersedes: listed observations obs-N on the same subject that this claim replaces because the rows show they
  changed; [] otherwise.
When rows disagree, the newer row states what holds.

Use only the ids and row numbers shown, and propose at most ${SALVAGE_REPLY_MAX_ITEMS} observations. When the rows hold nothing
durable, reply {"observations":[]}.

Reply with only a JSON object of exactly this shape:
{"observations":[{"claim":"...","quote":"...","kind":"fact","subject":{"id":"subj-1"},"evidence":[1],"supersedes":[]}]}`

/**
 * The reply's schema; parseSalvageReply enforces exactly this, except that
 * a reply holding more than `maxItems` observations is read, and the items
 * past the bound count as schema rejections. Every string, array and number
 * is bounded, so the reply's length is bounded too: SALVAGE_REPLY_MAX_TOKENS
 * is derived from these bounds.
 */
export const SALVAGE_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['observations'],
  properties: {
    observations: {
      type: 'array',
      maxItems: SALVAGE_REPLY_MAX_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'quote', 'kind', 'subject', 'evidence', 'supersedes'],
        properties: {
          claim: { type: 'string', minLength: SALVAGE_CLAIM_MIN_CHARS, maxLength: SALVAGE_CLAIM_MAX_CHARS },
          quote: { type: 'string', minLength: SALVAGE_QUOTE_MIN_CHARS, maxLength: SALVAGE_QUOTE_MAX_CHARS },
          kind: { enum: OBSERVATION_KINDS },
          subject: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['id'],
                properties: { id: { type: 'string', maxLength: SUBJECT_ALIAS_MAX_CHARS } },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['new'],
                properties: { new: { type: 'string', maxLength: SUBJECT_LABEL_MAX_CHARS } },
              },
            ],
          },
          evidence: {
            type: 'array',
            minItems: SALVAGE_EVIDENCE_MIN,
            maxItems: SALVAGE_EVIDENCE_MAX,
            items: { type: 'integer', minimum: ROW_NUMBER_MIN, maximum: ROW_NUMBER_MAX },
          },
          supersedes: {
            type: 'array',
            maxItems: SALVAGE_OBSERVATION_LISTING,
            items: { type: 'string', maxLength: OBSERVATION_ALIAS_MAX_CHARS },
          },
        },
      },
    },
  },
} as const

// --- The reply's token cap ---------------------------------------------------

/** A reply spends at least this many characters per token, so its characters over this bound its tokens. */
export const SALVAGE_REPLY_MIN_CHARS_PER_TOKEN = 2

const ITEM_SEPARATOR = ','
/** A reply may wrap its object in a fenced block; extractJsonReply reads it there. */
const REPLY_FENCE_OPEN = '```json\n'
const REPLY_FENCE_CLOSE = '\n```'
const LONGEST_KIND = OBSERVATION_KINDS.reduce((a, b) => (b.length > a.length ? b : a))

/**
 * One reply item's characters besides its claim, quote and subject label:
 * the keys and punctuation, the longest kind, evidence and supersedes at
 * their schema bounds, and the separator before the next item.
 */
export const SALVAGE_ITEM_JSON_OVERHEAD_CHARS =
  JSON.stringify({
    claim: '',
    quote: '',
    kind: LONGEST_KIND,
    subject: { new: '' },
    evidence: Array.from({ length: SALVAGE_EVIDENCE_MAX }, () => ROW_NUMBER_MAX),
    supersedes: Array.from({ length: SALVAGE_OBSERVATION_LISTING }, () => OBSERVATION_ALIAS_PREFIX.padEnd(OBSERVATION_ALIAS_MAX_CHARS, '9')),
  }).length + ITEM_SEPARATOR.length

/** The reply around its items: the object and its key, inside a fence. */
export const SALVAGE_REPLY_ENVELOPE_CHARS = `${REPLY_FENCE_OPEN}${JSON.stringify({ observations: [] })}${REPLY_FENCE_CLOSE}`.length

/**
 * The reply's max_tokens, from the schema's bounds rather than the prompt's
 * size: a reply of SALVAGE_REPLY_MAX_ITEMS items with every field at its
 * maximum fits under it, so a schema-valid reply is never cut off.
 */
export const SALVAGE_REPLY_MAX_TOKENS = Math.ceil(
  (SALVAGE_REPLY_MAX_ITEMS *
    (SALVAGE_CLAIM_MAX_CHARS + SALVAGE_QUOTE_MAX_CHARS + SUBJECT_LABEL_MAX_CHARS + SALVAGE_ITEM_JSON_OVERHEAD_CHARS) +
    SALVAGE_REPLY_ENVELOPE_CHARS) /
    SALVAGE_REPLY_MIN_CHARS_PER_TOKEN,
)

/** A subject the prompt lists, aliased subj-N. */
export interface ListedSubject {
  alias: string
  id: string
  label: string
  projectId: string | null
}

/** A current salvage observation the prompt lists, aliased obs-N, newest first. */
export interface ListedObservation {
  alias: string
  id: string
  kind: string
  subjectId: string | null
  subjectLabel: string | null
  projectId: string | null
  workspaceId: string | null
  content: string
  occurredAt: string
}

export interface SalvageListing {
  subjects: ListedSubject[]
  observations: ListedObservation[]
}

/** What the message shows of a window: its rendered rows and the project of each row. */
export interface SalvagePromptWindow {
  text: string
  rowProjects: ReadonlyArray<string | null>
}

export type SalvageSubjectRef = { id: string } | { new: string }

export interface ProposedSalvage {
  /** The observation's position in the reply array. */
  index: number
  claim: string
  /** The words of a cited row the claim follows from, trimmed. */
  quote: string
  kind: ObservationKind
  subject: SalvageSubjectRef
  evidence: number[]
  supersedes: string[]
}

export type ParsedSalvageReply =
  | { ok: true; observations: ProposedSalvage[]; schemaRejected: number[] }
  | { ok: false; reason: string }

/** The user message: the listings, which project each row belongs to when there are several, then the rows. */
export function renderSalvageMessage(window: SalvagePromptWindow, listing: SalvageListing): string {
  const parts: string[] = []
  const projects = projectRows(window.rowProjects)
  if (projects.size > 1) {
    parts.push(section('PROJECTS', [...projects].map(([project, rows]) => `${projectName(project)}: rows ${ranges(rows)}`)))
  }
  parts.push(section('SUBJECTS', listing.subjects.map((s) => `${s.alias} (project ${projectName(s.projectId)}) ${oneLine(s.label)}`)))
  parts.push(section('OBSERVATIONS', listing.observations.map(observationLine)))
  parts.push(`ROWS:\n${window.text}`)
  return parts.join('\n\n')
}

export function parseSalvageReply(text: string): ParsedSalvageReply {
  let reply: { observations: unknown[] }
  try {
    reply = extractJsonReply(text, isReplyObject) as { observations: unknown[] }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
  const observations: ProposedSalvage[] = []
  const schemaRejected: number[] = []
  reply.observations.forEach((raw, index) => {
    const proposal = index < SALVAGE_REPLY_MAX_ITEMS ? toProposal(raw, index) : null
    if (proposal) observations.push(proposal)
    else schemaRejected.push(index)
  })
  return { ok: true, observations, schemaRejected }
}

function isReplyObject(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['observations']) && Array.isArray(value.observations)
}

const ITEM_KEYS = ['claim', 'quote', 'kind', 'subject', 'evidence', 'supersedes'] as const

function toProposal(raw: unknown, index: number): ProposedSalvage | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ITEM_KEYS)) return null
  const { claim, quote, kind, subject, evidence, supersedes } = raw
  const claimText = trimmedWithin(claim, SALVAGE_CLAIM_MIN_CHARS, SALVAGE_CLAIM_MAX_CHARS)
  const quoteText = trimmedWithin(quote, SALVAGE_QUOTE_MIN_CHARS, SALVAGE_QUOTE_MAX_CHARS)
  if (claimText === null || quoteText === null) return null
  if (!(OBSERVATION_KINDS as readonly unknown[]).includes(kind)) return null
  const ref = toSubject(subject)
  if (ref === null) return null
  if (!Array.isArray(evidence) || evidence.length < SALVAGE_EVIDENCE_MIN || evidence.length > SALVAGE_EVIDENCE_MAX) return null
  if (!evidence.every(isRowNumber)) return null
  if (!Array.isArray(supersedes) || supersedes.length > SALVAGE_OBSERVATION_LISTING) return null
  if (!supersedes.every((s) => typeof s === 'string' && codePoints(s) <= OBSERVATION_ALIAS_MAX_CHARS)) return null
  return {
    index,
    claim: claimText,
    quote: quoteText,
    kind: kind as ObservationKind,
    subject: ref,
    evidence: [...(evidence as number[])],
    supersedes: [...(supersedes as string[])],
  }
}

function toSubject(raw: unknown): SalvageSubjectRef | null {
  if (!isRecord(raw)) return null
  if (hasExactKeys(raw, ['id']) && typeof raw.id === 'string' && codePoints(raw.id) <= SUBJECT_ALIAS_MAX_CHARS) {
    return { id: raw.id }
  }
  if (hasExactKeys(raw, ['new']) && typeof raw.new === 'string' && codePoints(raw.new) <= SUBJECT_LABEL_MAX_CHARS) {
    return { new: raw.new }
  }
  return null
}

/** The trimmed string when its length in code points is within [min, max], else null. */
function trimmedWithin(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const length = codePoints(trimmed)
  return length < min || length > max ? null : trimmed
}

function isRowNumber(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= ROW_NUMBER_MIN && (value as number) <= ROW_NUMBER_MAX
}

function observationLine(o: ListedObservation): string {
  const subject = o.subjectLabel === null ? '' : `; subject ${oneLine(o.subjectLabel)}`
  return `${o.alias} (project ${projectName(o.projectId)}${subject}; ${o.occurredAt.slice(0, 10)}) ${oneLine(o.content)}`
}

function projectRows(rowProjects: ReadonlyArray<string | null>): Map<string | null, number[]> {
  const out = new Map<string | null, number[]>()
  rowProjects.forEach((project, i) => out.set(project, [...(out.get(project) ?? []), i + 1]))
  return out
}

/** `1-3, 5, 7-8` for [1, 2, 3, 5, 7, 8]; the numbers arrive ascending. */
function ranges(numbers: readonly number[]): string {
  const spans: string[] = []
  let start = numbers[0]!
  let end = start
  for (const n of numbers.slice(1)) {
    if (n === end + 1) {
      end = n
      continue
    }
    spans.push(start === end ? `${start}` : `${start}-${end}`)
    start = n
    end = n
  }
  spans.push(start === end ? `${start}` : `${start}-${end}`)
  return spans.join(', ')
}

function projectName(project: string | null): string {
  return project ?? 'none'
}

function section(header: string, lines: readonly string[]): string {
  return `${header}:\n${lines.length === 0 ? 'none' : lines.join('\n')}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function codePoints(text: string): number {
  return [...text].length
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
