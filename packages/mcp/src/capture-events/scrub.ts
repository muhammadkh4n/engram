/**
 * Scrubs a validated capture event before it is stored: every string goes
 * through `scrubSecrets` (the process-wide registry, which also holds the
 * server's own credentials) except identifiers, which are matched exactly
 * downstream and carry no free text. Each redaction is listed by field path,
 * detector and secret name, never by value.
 *
 * A prompt longer than USER_PROMPT_TEXT_MAX_CHARS is cut after scrubbing, so
 * a secret straddling the cut is still masked whole.
 */

import { scrubSecrets } from '@engram-mem/core'
import { USER_PROMPT_TEXT_MAX_CHARS } from './contract.js'
import type { AnswerQuestion, CaptureEvent, UserAnswerPayload, UserPromptPayload } from './contract.js'

/** One masked value: where it was and what matched it. */
export interface MaskedSecret {
  /** Path of the field, e.g. `payload.questions[0].question`. */
  field: string
  /** The redaction kind (`known`, `authorization`, a secretlint rule, …). */
  detector: string
  /** The registered secret's name for a known value, else null. */
  secret_name: string | null
}

export interface ScrubbedEvent {
  event: CaptureEvent
  masked: MaskedSecret[]
}

/**
 * Payload keys holding identifiers, at any depth of a payload: ids, slugs,
 * hashes, enum values and timestamps. `name` is a tool name and `id` also
 * covers a legacy origin's item id.
 */
const PAYLOAD_IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
  'item_ids',
  'prompt_event_uuid',
  'channel',
  'repo',
  'sha',
  'authored_at',
  'plan',
  'id',
  'class',
  'by',
  'phase',
  'task',
  'status',
  'said_at',
  'scope',
  'supersedes',
  'item_id',
  'register_id',
  'name',
])

type Scrub = (text: string, field: string) => Promise<string>

export async function scrubEvent(event: CaptureEvent): Promise<ScrubbedEvent> {
  const masked: MaskedSecret[] = []
  const scrub: Scrub = async (text, field) => {
    const result = await scrubSecrets(text)
    for (const r of result.redactions) masked.push({ field, detector: r.kind, secret_name: r.name ?? null })
    return result.text
  }
  const orNull = async (text: string | null, field: string): Promise<string | null> =>
    text === null ? null : scrub(text, field)

  const cwd = await orNull(event.cwd, 'cwd')
  const project = {
    id: event.project.id,
    workspace: event.project.workspace,
    repo_root: await orNull(event.project.repo_root, 'project.repo_root'),
    branch: await orNull(event.project.branch, 'project.branch'),
    worktree: await orNull(event.project.worktree, 'project.worktree'),
  }
  const planDirs: string[] = []
  for (const [i, dir] of event.plan_dirs.entries()) planDirs.push(await scrub(dir, `plan_dirs[${i}]`))

  let payload: unknown
  if (event.type === 'user_answer') payload = await scrubAnswer(event.payload, scrub)
  else payload = await scrubValue(event.payload, 'payload', scrub)
  if (event.type === 'user_prompt') payload = cutPrompt(payload as UserPromptPayload)

  return { event: { ...event, cwd, project, plan_dirs: planDirs, payload } as CaptureEvent, masked }
}

async function scrubValue(value: unknown, path: string, scrub: Scrub): Promise<unknown> {
  if (typeof value === 'string') return scrub(value, path)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const [i, inner] of value.entries()) out.push(await scrubValue(inner, `${path}[${i}]`, scrub))
    return out
  }
  if (value !== null && typeof value === 'object') {
    const entries: Array<[string, unknown]> = []
    for (const [key, inner] of Object.entries(value)) {
      entries.push([key, PAYLOAD_IDENTIFIER_KEYS.has(key) ? inner : await scrubValue(inner, `${path}.${key}`, scrub)])
    }
    return Object.fromEntries(entries)
  }
  return value
}

/**
 * `answers` and `notes` are keyed by question text, so they are re-keyed to
 * the scrubbed question. Their field path names the question by position
 * (`payload.answers[questions[0]]`), since the key itself is unscrubbed text.
 */
async function scrubAnswer(payload: UserAnswerPayload, scrub: Scrub): Promise<UserAnswerPayload> {
  const questions = distinctQuestions(
    (await scrubValue(payload.questions, 'payload.questions', scrub)) as AnswerQuestion[],
  )
  const position = new Map(payload.questions.map((q, i) => [q.question, i]))
  // Built with fromEntries: bracket assignment of a `__proto__` key on `{}`
  // would set the prototype and drop the answer.
  const rekey = async (map: Record<string, string>, name: 'answers' | 'notes'): Promise<Record<string, string>> => {
    const entries: Array<[string, string]> = []
    for (const [key, value] of Object.entries(map)) {
      // Validation refuses a key naming no question, so the lookup always hits.
      const i = position.get(key) ?? 0
      entries.push([questions[i]!.question, await scrub(value, `payload.${name}[questions[${i}]]`)])
    }
    return Object.fromEntries(entries)
  }
  const out: UserAnswerPayload = {
    questions,
    answers: await rekey(payload.answers, 'answers'),
    transcript_line: payload.transcript_line,
  }
  if (payload.notes !== undefined) out.notes = await rekey(payload.notes, 'notes')
  if (payload.response !== undefined) out.response = await scrub(payload.response, 'payload.response')
  return out
}

/**
 * Two questions that differed only in a masked value read the same once
 * scrubbed; a later one gets ` (question <n>)` appended so the answer maps
 * keep one key per question and no answer is lost.
 */
function distinctQuestions(questions: AnswerQuestion[]): AnswerQuestion[] {
  const seen = new Set<string>()
  return questions.map((q, i) => {
    let text = q.question
    while (seen.has(text)) text = `${text} (question ${i + 1})`
    seen.add(text)
    return text === q.question ? q : { ...q, question: text }
  })
}

function cutPrompt(payload: UserPromptPayload): UserPromptPayload {
  if (payload.text.length <= USER_PROMPT_TEXT_MAX_CHARS) return payload
  let end = USER_PROMPT_TEXT_MAX_CHARS
  const last = payload.text.charCodeAt(end - 1)
  // Never keep the first half of a surrogate pair without its second.
  if (last >= 0xd800 && last <= 0xdbff) end--
  return { ...payload, text: payload.text.slice(0, end), truncated: true }
}
