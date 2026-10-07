/**
 * The legacy salvage prompt: one session's old memory rows go to the model,
 * which proposes durable knowledge as observations that cite the rows by
 * number. The model only proposes; the salvage gate decides.
 *
 * Any change to the prompt or the reply schema below must come with a new
 * SALVAGE_VERSION: runs and window keys carry the version, so a changed prompt
 * under an old version would make a completed window look done for a prompt
 * it never ran with. The version test pins the sha256 of both.
 */
import { extractJsonReply, OBSERVATION_KINDS, type ObservationKind } from '@engram-mem/core'

export const SALVAGE_VERSION = 'legacy-salvage-v1'
/** Names the call site in logs; never sent to the model. */
export const SALVAGE_LABEL = 'legacy-salvage'
export const SALVAGE_CLAIM_MAX_CHARS = 1000
export const SALVAGE_EVIDENCE_MIN = 1
export const SALVAGE_EVIDENCE_MAX = 10

export const SALVAGE_SYSTEM_PROMPT = `You read rows from an old memory store and propose the durable knowledge they hold, as observations. Code checks
every observation; one that breaks a rule below is discarded.

ROWS are one session's records, oldest first, each one line: "[n] <date time> <label>: <text>".
- assistant: what the AI assistant wrote.
- system: a record a tool or hook wrote.
- digest: an old model-written summary of part of the session.
- fact: a fact an old model took from a digest.
- user: MK's prompt as an old model rewrote it, not his words. It is context only: an observation that cites a user
  row must also cite a row that is not a user row, and never takes a decision, wish or preference from it.

OBSERVATIONS are durable knowledge a later session can use: how code, a system or a tool is; a procedure that worked;
what an investigation established.
- claim: one standalone sentence of at most 1000 characters that a reader who never saw the session understands.
  Name the repository, file, system or ticket; resolve "it", "the PR" and "this". No hedging.
- Never narrate progress or steps ("I read the file", "the assistant ran the tests", "next we will ..."), and skip
  plans and proposals the rows do not show carried out.
- Never attribute a decision, wish or preference to MK, to the user or to "we" ("MK decided", "we agreed", "the user
  wants"). State the knowledge itself: not "We decided to use Postgres" but "The store runs on Postgres".
- kind: "fact" (how something is), "procedure" (how to do something) or "finding" (what an investigation
  established).
- evidence: the row numbers n that show the claim, 1 to 10 of them, at least one of them not a user row.
- subject: what it is about, as a short noun phrase. Reuse a listed subject {"id": "subj-N"} of the project the cited
  rows belong to when one fits; give {"new": "<label>"} only when none does.
- supersedes: listed observations obs-N on the same subject that this claim replaces because the rows show they
  changed; [] otherwise.
When rows disagree, the newer row states what holds.

Use only the ids and row numbers shown. When the rows hold nothing durable, return an empty list.

Reply with only a JSON object of exactly this shape:
{"observations":[{"claim":"...","kind":"fact","subject":{"id":"subj-1"},"evidence":[1],"supersedes":[]}]}`

/** The reply's schema; parseSalvageReply enforces exactly this. */
export const SALVAGE_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['observations'],
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'kind', 'subject', 'evidence', 'supersedes'],
        properties: {
          claim: { type: 'string', minLength: 1, maxLength: SALVAGE_CLAIM_MAX_CHARS },
          kind: { enum: OBSERVATION_KINDS },
          subject: {
            oneOf: [
              { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
              { type: 'object', additionalProperties: false, required: ['new'], properties: { new: { type: 'string' } } },
            ],
          },
          evidence: {
            type: 'array',
            minItems: SALVAGE_EVIDENCE_MIN,
            maxItems: SALVAGE_EVIDENCE_MAX,
            items: { type: 'integer' },
          },
          supersedes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const

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
    const proposal = toProposal(raw, index)
    if (proposal) observations.push(proposal)
    else schemaRejected.push(index)
  })
  return { ok: true, observations, schemaRejected }
}

function isReplyObject(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['observations']) && Array.isArray(value.observations)
}

function toProposal(raw: unknown, index: number): ProposedSalvage | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['claim', 'kind', 'subject', 'evidence', 'supersedes'])) return null
  const { claim, kind, subject, evidence, supersedes } = raw
  if (typeof claim !== 'string') return null
  const trimmed = claim.trim()
  const length = [...trimmed].length
  if (length < 1 || length > SALVAGE_CLAIM_MAX_CHARS) return null
  if (!(OBSERVATION_KINDS as readonly unknown[]).includes(kind)) return null
  const ref = toSubject(subject)
  if (ref === null) return null
  if (!Array.isArray(evidence) || evidence.length < SALVAGE_EVIDENCE_MIN || evidence.length > SALVAGE_EVIDENCE_MAX) return null
  if (!evidence.every((n) => Number.isInteger(n))) return null
  if (!Array.isArray(supersedes) || !supersedes.every((s) => typeof s === 'string')) return null
  return {
    index,
    claim: trimmed,
    kind: kind as ObservationKind,
    subject: ref,
    evidence: [...(evidence as number[])],
    supersedes: [...(supersedes as string[])],
  }
}

function toSubject(raw: unknown): SalvageSubjectRef | null {
  if (!isRecord(raw)) return null
  if (hasExactKeys(raw, ['id']) && typeof raw.id === 'string') return { id: raw.id }
  if (hasExactKeys(raw, ['new']) && typeof raw.new === 'string') return { new: raw.new }
  return null
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
