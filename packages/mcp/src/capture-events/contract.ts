/**
 * The wire contract of `POST /capture/events`: the request envelope, one
 * payload type per capture event type, and every limit the route enforces.
 * Clients import these constants so they cut and batch exactly as the
 * server validates.
 */

import type { CaptureEventType } from '@engram-mem/core'

// ── Envelope and body ────────────────────────────────────────────────────

/** A larger body is drained and answered 413. A 1,000,000-char prompt is at most ~6 MB of fully escaped JSON. */
export const CAPTURE_EVENTS_BODY_MAX_BYTES = 8 * 1024 * 1024
export const CAPTURE_EVENTS_MIN = 1
export const CAPTURE_EVENTS_MAX = 500
/**
 * Deepest nesting of objects and arrays in one event or in the client, the
 * event or client itself being level 1. It is checked by an iterative walk
 * before any recursive step, so no input can overflow the stack.
 */
export const CAPTURE_NESTING_MAX_LEVELS = 64
export const CAPTURE_CLIENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const CAPTURE_CLIENT_VERSION_MAX_CHARS = 64
/** Events posted by this client are backfill: materialized after every live session. */
export const CAPTURE_BACKFILL_CLIENT = 'engram-backfill'

// ── Text limits ──────────────────────────────────────────────────────────

/** Every free-text string, except a prompt's `text`, is capped here. */
export const CAPTURE_FREE_TEXT_MAX_CHARS = 200_000
/** A prompt is never rejected for its length; the route keeps this many leading chars. */
export const USER_PROMPT_TEXT_MAX_CHARS = 1_000_000

// ── Event fields ─────────────────────────────────────────────────────────

export const CAPTURE_SESSION_ID_MAX_CHARS = 256
export const CAPTURE_EVENT_UUID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
/** The earliest accepted `occurred_at`. */
export const CAPTURE_OCCURRED_AT_MIN = '2020-01-01T00:00:00Z'
export const CAPTURE_OCCURRED_AT_MIN_MS = Date.parse(CAPTURE_OCCURRED_AT_MIN)
/** How far past the server's receipt time an `occurred_at` may lie (client clock skew). */
export const CAPTURE_OCCURRED_AT_MAX_FUTURE_MS = 10 * 60 * 1000
export const CAPTURE_CWD_MAX_CHARS = 4096
export const CAPTURE_PROJECT_ID_MAX_CHARS = 100
export const CAPTURE_PROJECT_WORKSPACE_MAX_CHARS = 100
export const CAPTURE_PROJECT_REPO_ROOT_MAX_CHARS = 4096
export const CAPTURE_PROJECT_BRANCH_MAX_CHARS = 256
export const CAPTURE_PROJECT_WORKTREE_MAX_CHARS = 256
export const CAPTURE_PLAN_DIRS_MAX = 20
export const CAPTURE_PLAN_DIR_MAX_CHARS = 4096

// ── Payload limits ───────────────────────────────────────────────────────

export const USER_ANSWER_QUESTIONS_MIN = 1
export const USER_ANSWER_QUESTIONS_MAX = 10
export const USER_ANSWER_HEADER_MAX_CHARS = 200
export const USER_ANSWER_OPTIONS_MAX = 20
export const USER_ANSWER_OPTION_LABEL_MAX_CHARS = 2000

export const ASSISTANT_TOOLS_MAX = 200
export const ASSISTANT_TOOL_NAME_MAX_CHARS = 128
export const ASSISTANT_TOOL_REF_MAX_CHARS = 4096

export const SESSION_REASON_MAX_CHARS = 256

export const GIT_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
/** A SHA-1 or SHA-256 object name, lowercase. */
export const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const GIT_FILES_MAX = 5000
export const GIT_FILE_MAX_CHARS = 4096

export const PLAN_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/
export const DECISION_ID_MAX_CHARS = 64
export const DECISION_CLASSES = ['A', 'B', 'C'] as const
export const DECISION_BY = ['mk', 'session'] as const
export const DECISION_QUOTE_SOURCE_MAX_CHARS = 1024
export const RULING_PHASE_MAX_CHARS = 32
export const RULING_TASK_MAX_CHARS = 32

export const BRIEFING_ITEM_IDS_MAX = 100
export const BRIEFING_CHANNEL_PATTERN = /^[a-z_]{1,32}$/

export const REGISTER_ID_PATTERN = /^R-[A-Z]{2,6}-[0-9]+$/
/**
 * A register entry's item keys are `register:<id>` and `register:<id>:<sha256
 * hex>`, and the item store bounds every event key to 512 chars.
 */
export const REGISTER_ID_MAX_CHARS = 64
export const REGISTER_STATUS_PATTERN = /^[a-z_]{1,32}$/
export const REGISTER_SUBJECT_MAX_CHARS = 200
export const REGISTER_VERIFIED_MAX_CHARS = 1024
export const REGISTER_APPLIES_TO_MAX = 50
export const REGISTER_APPLIES_TO_ITEM_MAX_CHARS = 200
export const REGISTER_TRIGGERS_MAX = 20
export const REGISTER_TRIGGER_ITEM_MAX_CHARS = 64
export const REGISTER_SUPERSEDES_MAX = 20
export const REGISTER_RESTATED_MAX = 100
export const REGISTER_RESTATED_ITEM_MAX_CHARS = 200
export const REGISTER_FILE_MAX_CHARS = 4096
/** The `<id>` of a `project:<id>` or `workspace:<id>` scope, as long as a project or workspace id. */
export const REGISTER_SCOPE_ID_MAX_CHARS = 100

export const CANDIDATE_STATUSES = ['recorded', 'dismissed'] as const
/** The item store's `register_ref` rule: a register entry id or a plan ledger decision. */
export const REGISTER_REF_PATTERN =
  /^(R-[A-Z]{2,6}-[0-9]+|plan:[a-z0-9][a-z0-9-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._-]{0,39})$/

/** Item ids as the item store emits them: canonical lowercase UUID text. */
export const ITEM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ── Types ────────────────────────────────────────────────────────────────

export interface CaptureClient {
  name: string
  version: string
}

export interface CaptureEventProject {
  id: string | null
  workspace: string | null
  repo_root: string | null
  branch: string | null
  worktree: string | null
}

export interface HistoryPromptOrigin {
  type: 'history'
  /** Equals the event's `occurred_at` in epoch milliseconds. */
  timestamp_ms: number
  line: number
  paste_missing: boolean
}

export interface LegacyPromptOrigin {
  type: 'legacy'
  table: 'memory_episodes'
  /** The id of the `legacy` item this prompt is recovered from. */
  id: string
  truncated: boolean
}

export type PromptOrigin = HistoryPromptOrigin | LegacyPromptOrigin

export interface UserPromptPayload {
  text: string
  truncated?: true
  /** Null only for a backfilled prompt, which carries an `origin`. */
  transcript_line: number | null
  origin?: PromptOrigin
}

export interface AnswerOption {
  label: string
  description: string
}

export interface AnswerQuestion {
  question: string
  header: string
  options: AnswerOption[]
  multiSelect: boolean
}

export interface UserAnswerPayload {
  questions: AnswerQuestion[]
  /** Keyed by question text. */
  answers: Record<string, string>
  /** Keyed by question text. */
  notes?: Record<string, string>
  response?: string
  transcript_line: number
}

export interface AssistantTool {
  name: string
  ref: string | null
}

export interface AssistantTurnPayload {
  text: string
  transcript_line: number
  tools: AssistantTool[]
}

export interface SessionMarkerPayload {
  reason?: string
}

export interface GitCommitPayload {
  repo: string
  sha: string
  message: string
  files: string[]
  authored_at: string
}

export type LedgerDecisionClass = (typeof DECISION_CLASSES)[number]
export type LedgerDecisionBy = (typeof DECISION_BY)[number]

export interface LedgerDecisionPayload {
  plan: string
  id: string
  class: LedgerDecisionClass
  trigger: string
  ruling: string
  by: LedgerDecisionBy
  /** Required, with `source`, when `by` is `mk`. */
  quote?: string
  source?: string
}

export interface LedgerRulingPayload {
  plan: string
  phase: string
  task: string
  ruling: string
  why: string
}

export interface BriefingShownPayload {
  item_ids: string[]
  channel: string
  prompt_event_uuid: string | null
}

export interface RegisterEntryPayload {
  id: string
  status: string
  subject: string
  said_at: string
  quote: string
  question: string | null
  verified: string
  applies_to: string[]
  triggers: string[]
  supersedes: string[]
  restated: string[]
  /** `global`, `project:<id>` or `workspace:<id>`. */
  scope: string
  file: string
}

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

export type CandidateStatusPayload =
  | { item_id: string; status: 'recorded'; register_id: string }
  | { item_id: string; status: 'dismissed' }

/** The payload of each capture event type. */
export interface CapturePayloads {
  user_prompt: UserPromptPayload
  user_answer: UserAnswerPayload
  assistant_turn: AssistantTurnPayload
  session_start: SessionMarkerPayload
  session_end: SessionMarkerPayload
  pre_compact: SessionMarkerPayload
  git_commit: GitCommitPayload
  ledger_decision: LedgerDecisionPayload
  ledger_ruling: LedgerRulingPayload
  briefing_shown: BriefingShownPayload
  register_entry: RegisterEntryPayload
  candidate_status: CandidateStatusPayload
}

// Compile-time proof that CapturePayloads covers exactly the core event types.
type MissingPayloads = Exclude<CaptureEventType, keyof CapturePayloads>
type ExtraPayloads = Exclude<keyof CapturePayloads, CaptureEventType>
const payloadsCoverEventTypes: [MissingPayloads, ExtraPayloads] extends [never, never] ? true : never = true
void payloadsCoverEventTypes

export interface CaptureEventBase {
  session_id: string
  event_uuid: string
  /** RFC 3339 with an offset, as sent. */
  occurred_at: string
  cwd: string | null
  project: CaptureEventProject
  plan_dirs: string[]
}

export type CaptureEventOf<T extends CaptureEventType> = CaptureEventBase & {
  type: T
  payload: CapturePayloads[T]
}

export type CaptureEvent = { [T in CaptureEventType]: CaptureEventOf<T> }[CaptureEventType]

export interface CaptureEventsRequest {
  client: CaptureClient
  events: unknown[]
}

/** An event that passed validation, with its position in the request. */
export interface ValidEvent {
  index: number
  event: CaptureEvent
}

/** An event refused by validation. `reason` names the path and the rule, never a value. */
export interface Rejection {
  index: number
  session_id: string | null
  event_uuid: string | null
  reason: string
}

export type ParsedCaptureEvents =
  | { error: string }
  | { client: CaptureClient; events: ValidEvent[]; rejected: Rejection[] }
