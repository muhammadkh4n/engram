/**
 * Reads the extraction model's reply. The chat call asks for JSON mode but
 * no schema, so this code is the schema: the whole reply must be one object
 * with exactly `statements` and `observations`, both arrays, and every item
 * must carry exactly its keys with the right types and enum values. A bad
 * item is recorded as a rejection, never thrown; only a reply that is not
 * that object fails as a whole. Aliases stay strings here; the gate resolves
 * them against the window.
 */
import { extractJsonReply } from '../utils/json-reply.js'

/** Every rejection rule, in the order the gate applies them. */
export const REJECTION_RULES = [
  'reply',
  'schema',
  'over_limit',
  'unknown_id',
  'quote_not_found',
  'question_not_found',
  'bad_subject',
  'attributed_to_user',
  'bad_date',
  'duplicate',
] as const
export type RejectionRule = (typeof REJECTION_RULES)[number]

export const STATEMENT_KINDS = ['ruling', 'fact', 'correction'] as const
export type StatementKind = (typeof STATEMENT_KINDS)[number]

export const OBSERVATION_KINDS = ['fact', 'procedure', 'finding'] as const
export type ObservationKind = (typeof OBSERVATION_KINDS)[number]

export const STATEMENT_SCOPES = ['global', 'workspace', 'project', 'plan', 'session'] as const
export type StatementScope = (typeof STATEMENT_SCOPES)[number]

export const EVIDENCE_TYPES = ['commit', 'pr', 'file', 'url'] as const
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]

export type ItemSide = 'statement' | 'observation'

export interface ExtractionRejection {
  item: ItemSide
  /** The item's position in its reply array. */
  index: number
  rule: RejectionRule
}

/** A listed subject by alias, or a label for a subject not listed. */
export type ProposedSubject = { id: string } | { new: string }

export interface ProposedEvidence {
  type: EvidenceType
  ref: string
}

export interface ProposedStatement {
  index: number
  utteranceId: string
  quote: string
  question: string | null
  kind: StatementKind
  standing: boolean
  scope: StatementScope
  subject: ProposedSubject
  appliesTo: string[]
  supersedes: string[]
  restates: string[]
  corrects: string[]
}

export interface ProposedObservation {
  index: number
  assistantUtteranceId: string
  claim: string
  kind: ObservationKind
  subject: ProposedSubject
  evidence: ProposedEvidence[]
  validAt: string | null
  supersedes: string[]
}

export type ParsedReply =
  | {
      ok: true
      statements: ProposedStatement[]
      observations: ProposedObservation[]
      rejected: ExtractionRejection[]
    }
  | { ok: false; rule: 'reply'; reason: string }

const STATEMENT_KEYS = [
  'utterance_id',
  'quote',
  'question',
  'kind',
  'standing',
  'scope',
  'subject',
  'applies_to',
  'supersedes',
  'restates',
  'corrects',
] as const

const OBSERVATION_KEYS = [
  'assistant_utterance_id',
  'claim',
  'kind',
  'subject',
  'evidence',
  'valid_at',
  'supersedes',
] as const

const REPLY_KEYS = ['statements', 'observations'] as const

export function parseReply(text: string): ParsedReply {
  let reply: Record<string, unknown[]>
  try {
    reply = extractJsonReply(text, isReplyObject) as Record<string, unknown[]>
  } catch (err) {
    return { ok: false, rule: 'reply', reason: err instanceof Error ? err.message : String(err) }
  }

  const rejected: ExtractionRejection[] = []
  const statements: ProposedStatement[] = []
  const observations: ProposedObservation[] = []
  reply['statements']!.forEach((raw, index) => {
    const statement = toStatement(raw, index)
    if (statement) statements.push(statement)
    else rejected.push({ item: 'statement', index, rule: 'schema' })
  })
  reply['observations']!.forEach((raw, index) => {
    const observation = toObservation(raw, index)
    if (observation) observations.push(observation)
    else rejected.push({ item: 'observation', index, rule: 'schema' })
  })
  return { ok: true, statements, observations, rejected }
}

function isReplyObject(value: unknown): boolean {
  return hasExactKeys(value, REPLY_KEYS) && REPLY_KEYS.every((k) => Array.isArray(value[k]))
}

function toStatement(raw: unknown, index: number): ProposedStatement | null {
  if (!hasExactKeys(raw, STATEMENT_KEYS)) return null
  const subject = toSubject(raw['subject'])
  if (
    typeof raw['utterance_id'] !== 'string' ||
    typeof raw['quote'] !== 'string' ||
    !isStringOrNull(raw['question']) ||
    !isOneOf(raw['kind'], STATEMENT_KINDS) ||
    typeof raw['standing'] !== 'boolean' ||
    !isOneOf(raw['scope'], STATEMENT_SCOPES) ||
    subject === null ||
    !isStringArray(raw['applies_to']) ||
    !isStringArray(raw['supersedes']) ||
    !isStringArray(raw['restates']) ||
    !isStringArray(raw['corrects'])
  ) {
    return null
  }
  return {
    index,
    utteranceId: raw['utterance_id'],
    quote: raw['quote'],
    question: raw['question'],
    kind: raw['kind'],
    standing: raw['standing'],
    scope: raw['scope'],
    subject,
    appliesTo: [...raw['applies_to']],
    supersedes: [...raw['supersedes']],
    restates: [...raw['restates']],
    corrects: [...raw['corrects']],
  }
}

function toObservation(raw: unknown, index: number): ProposedObservation | null {
  if (!hasExactKeys(raw, OBSERVATION_KEYS)) return null
  const subject = toSubject(raw['subject'])
  const evidence = toEvidence(raw['evidence'])
  if (
    typeof raw['assistant_utterance_id'] !== 'string' ||
    typeof raw['claim'] !== 'string' ||
    !isOneOf(raw['kind'], OBSERVATION_KINDS) ||
    subject === null ||
    evidence === null ||
    !isStringOrNull(raw['valid_at']) ||
    !isStringArray(raw['supersedes'])
  ) {
    return null
  }
  return {
    index,
    assistantUtteranceId: raw['assistant_utterance_id'],
    claim: raw['claim'],
    kind: raw['kind'],
    subject,
    evidence,
    validAt: raw['valid_at'],
    supersedes: [...raw['supersedes']],
  }
}

function toSubject(raw: unknown): ProposedSubject | null {
  if (hasExactKeys(raw, ['id'] as const) && typeof raw['id'] === 'string') return { id: raw['id'] }
  if (hasExactKeys(raw, ['new'] as const) && typeof raw['new'] === 'string') return { new: raw['new'] }
  return null
}

function toEvidence(raw: unknown): ProposedEvidence[] | null {
  if (!Array.isArray(raw)) return null
  const out: ProposedEvidence[] = []
  for (const entry of raw) {
    if (!hasExactKeys(entry, ['type', 'ref'] as const)) return null
    if (!isOneOf(entry['type'], EVIDENCE_TYPES) || typeof entry['ref'] !== 'string') return null
    out.push({ type: entry['type'], ref: entry['ref'] })
  }
  return out
}

function hasExactKeys<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k))
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}
