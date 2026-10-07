/**
 * MK's own words in old capture rows, sent as `user_prompt` events through
 * the capture route, so they are scrubbed, materialized, embedded and
 * extracted like any prompt.
 *
 * The old row's `content` is a model rewrite, so it never becomes MK's words:
 * the text comes from `metadata.rawTurn`, the captured turn itself, through
 * `legacyUserText`. A session the store already holds transcript or history
 * utterances for is skipped, since those carry the same words whole.
 *
 * The run refuses to start while the store could still change under it: a
 * capture event not yet processed may add a covering utterance, a legacy
 * copy step with work left may add or forget a candidate, and a legacy item
 * whose old row was forgotten but which is not forgotten yet would send a
 * forgotten row's words back.
 */

import type { PostgrestClient } from '@supabase/postgrest-js'
import type { CaptureEvent } from '../capture/events.js'
import { eventUuidFromParts } from '../capture/event-uuid.js'
import { LEGACY_STEPS } from './legacy-copy.js'
import { legacyUserText, RAW_TURN_CAP_CHARS } from './legacy-text.js'
import { countPrepared, emptyTally, prepareEvents, type SendTally, type SendTarget, sendSession } from './send.js'

/** The producer tag old prompt capture wrote into `metadata.source`. */
export const LEGACY_PROMPT_PRODUCER = 'claude-code-hook'
export const LEGACY_UTTERANCES_DEFAULT_TARGET = 'http://127.0.0.1:3850'
const PAGE_ROWS = 1000
/** Ids per `in.(…)` filter, which travels in the URL. */
const IN_LIST_ROWS = 100

export interface LegacyCandidate {
  id: string
  session_id: string | null
  project_id: string | null
  workspace_id: string | null
}

export interface LegacyRawTurn {
  raw_turn: string | null
  created_at: string
}

export interface LegacyUtteranceStore {
  /** Capture events with neither `processed_at` nor `error`. */
  unsettledCaptureEvents(): Promise<number>
  /** The first legacy copy step that still lists work, or null. */
  legacyStepWithWork(): Promise<string | null>
  /** Live legacy items whose old row had been forgotten when it was copied. */
  unforgottenLegacyItems(): Promise<number>
  /** Live legacy items of old prompt-capture rows (role user), by id. */
  candidates(): Promise<LegacyCandidate[]>
  /** Which of the sessions hold an utterance from a transcript or the history file. */
  coveredSessions(sessionIds: readonly string[]): Promise<Set<string>>
  /** Each old row's raw turn and creation time, by id. */
  rawTurns(ids: readonly string[]): Promise<Map<string, LegacyRawTurn>>
}

export interface LegacyUtterancesSummary extends SendTally {
  command: 'legacy-utterances'
  apply: boolean
  candidates: number
  covered: number
  excluded: Record<string, number>
  /** Events that reached the route check and were ready to send. */
  sent: number
  stopped: string | null
}

export interface LegacyUtterancesOptions {
  store: LegacyUtteranceStore
  /** Absent on a dry run. */
  send?: SendTarget
  log: (line: string) => void
  now?: () => Date
}

export class LegacyUtterancesRefused extends Error {}

async function refuseUnsettled(store: LegacyUtteranceStore): Promise<void> {
  const unsettled = await store.unsettledCaptureEvents()
  if (unsettled > 0) {
    throw new LegacyUtterancesRefused(
      `${unsettled} capture events are neither processed nor failed, so which sessions are covered is not known yet`,
    )
  }
  const step = await store.legacyStepWithWork()
  if (step !== null) throw new LegacyUtterancesRefused(`the legacy copy step ${step} has work left; run legacy-copy first`)
  const unforgotten = await store.unforgottenLegacyItems()
  if (unforgotten > 0) {
    throw new LegacyUtterancesRefused(
      `${unforgotten} legacy items of forgotten old rows are not forgotten yet; run legacy-copy to finish its forgets step`,
    )
  }
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

/** The prompt event for one old row's words; the uuid is fixed by the row id, so a resend is a duplicate. */
export function legacyPromptEvent(c: LegacyCandidate & { session_id: string }, text: string, raw: LegacyRawTurn): CaptureEvent {
  return {
    session_id: c.session_id,
    event_uuid: eventUuidFromParts('legacy', c.id),
    type: 'user_prompt',
    occurred_at: new Date(raw.created_at).toISOString(),
    cwd: null,
    project: { id: c.project_id, workspace: c.workspace_id, repo_root: null, branch: null, worktree: null },
    plan_dirs: [],
    payload: {
      text,
      transcript_line: null,
      origin: { type: 'legacy', table: 'memory_episodes', id: c.id, truncated: (raw.raw_turn ?? '').length >= RAW_TURN_CAP_CHARS },
    },
  } as CaptureEvent
}

function bySession(candidates: readonly LegacyCandidate[]): Map<string | null, LegacyCandidate[]> {
  const groups = new Map<string | null, LegacyCandidate[]>()
  for (const c of candidates) groups.set(c.session_id, [...(groups.get(c.session_id) ?? []), c])
  return groups
}

export async function runLegacyUtterances(opts: LegacyUtterancesOptions): Promise<LegacyUtterancesSummary> {
  await refuseUnsettled(opts.store)
  const now = opts.now ?? (() => new Date())
  const candidates = await opts.store.candidates()
  const summary: LegacyUtterancesSummary = {
    command: 'legacy-utterances',
    apply: opts.send !== undefined,
    candidates: candidates.length,
    covered: 0,
    excluded: {},
    sent: 0,
    stopped: null,
    ...emptyTally(),
  }
  const groups = bySession(candidates)
  const sessions = [...groups.keys()].filter((s): s is string => s !== null)
  const covered = await opts.store.coveredSessions(sessions)
  const sessionless = groups.get(null)?.length ?? 0
  if (sessionless > 0) summary.excluded.no_session = sessionless

  for (const session of sessions) {
    const rows = groups.get(session)!
    if (covered.has(session)) {
      summary.covered += rows.length
      continue
    }
    const raws = await opts.store.rawTurns(rows.map((r) => r.id))
    const events: CaptureEvent[] = []
    for (const row of rows) {
      const raw = raws.get(row.id)
      if (raw === undefined || typeof raw.raw_turn !== 'string') {
        bump(summary.excluded, 'no_raw_turn')
        continue
      }
      const words = legacyUserText(raw.raw_turn)
      if ('excluded' in words) bump(summary.excluded, words.excluded)
      else events.push(legacyPromptEvent({ ...row, session_id: session }, words.text, raw))
    }
    if (events.length === 0) continue
    events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_uuid.localeCompare(b.event_uuid))
    const prepared = await prepareEvents(events, { now: now(), log: opts.log })
    summary.sent += prepared.ready.length
    if (opts.send === undefined) {
      countPrepared(summary, prepared)
      continue
    }
    const outcome = await sendSession(opts.send, session, prepared, summary)
    if (!outcome.delivered) {
      summary.stopped = String(outcome.stopped)
      return summary
    }
  }
  return summary
}

// ── PostgREST ────────────────────────────────────────────────────────────

function failed(what: string, error: { message: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? 'no data'}`)
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

/** The store behind PostgREST as `service_role`, read only. */
export function postgrestLegacyUtteranceStore(client: PostgrestClient): LegacyUtteranceStore {
  return {
    async unsettledCaptureEvents() {
      const { count, error } = await client
        .from('memory_capture_events')
        .select('id', { count: 'exact', head: true })
        .is('processed_at', null)
        .is('error', null)
      if (error || count === null) failed('count unsettled capture events', error)
      return count
    },
    async legacyStepWithWork() {
      for (const step of LEGACY_STEPS) {
        const { data, error } = await client.rpc('engram_legacy_pending', { p_step: step, p_limit: 1 })
        if (error || !Array.isArray(data)) failed(`engram_legacy_pending ${step}`, error)
        if (data.length > 0) return step
      }
      return null
    },
    async unforgottenLegacyItems() {
      const { count, error } = await client
        .from('memory_items')
        .select('id', { count: 'exact', head: true })
        .eq('class', 'legacy')
        .not('source->>legacy_forgotten_at', 'is', null)
        .is('forgotten_at', null)
      if (error || count === null) failed('count unforgotten legacy items', error)
      return count
    },
    async candidates() {
      const out: LegacyCandidate[] = []
      let after: string | null = null
      for (;;) {
        let q = client
          .from('memory_items')
          .select('id, session_id, project_id, workspace_id')
          .eq('class', 'legacy')
          .eq('kind', 'legacy_episode')
          .eq('source->>table', 'memory_episodes')
          .eq('source->>producer', LEGACY_PROMPT_PRODUCER)
          .eq('source->>role', 'user')
          .is('forgotten_at', null)
          .order('id')
          .limit(PAGE_ROWS)
        if (after !== null) q = q.gt('id', after)
        const { data, error } = await q
        if (error || !data) failed('read legacy prompt items', error)
        const rows = data as LegacyCandidate[]
        out.push(...rows)
        if (rows.length < PAGE_ROWS) return out
        after = rows[rows.length - 1]!.id
      }
    },
    async coveredSessions(sessionIds) {
      // One bounded lookup per session: a transcript session holds thousands of
      // utterances, and a listing across many sessions would be cut at the
      // server's row cap and leave covered sessions looking uncovered.
      const covered = new Set<string>()
      for (const session of sessionIds) {
        const { data, error } = await client
          .from('memory_items')
          .select('id')
          .eq('class', 'utterance')
          .eq('session_id', session)
          .in('source->>type', ['transcript', 'history'])
          .limit(1)
        if (error || !data) failed('read covering utterances', error)
        if (data.length > 0) covered.add(session)
      }
      return covered
    },
    async rawTurns(ids) {
      const out = new Map<string, LegacyRawTurn>()
      for (const part of chunks(ids, IN_LIST_ROWS)) {
        const { data, error } = await client
          .from('memory_episodes')
          .select('id, created_at, raw_turn:metadata->>rawTurn')
          .in('id', part)
        if (error || !data) failed('read old capture rows', error)
        for (const r of data as Array<{ id: string } & LegacyRawTurn>) {
          out.set(r.id, { raw_turn: r.raw_turn, created_at: r.created_at })
        }
      }
      return out
    },
  }
}
