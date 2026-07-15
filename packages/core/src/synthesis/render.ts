/**
 * Template rendering for synthesis blocks. Every number and date in the
 * output is computed by deterministic code in this module or its imports —
 * the LLM's contribution ends at selection/labeling (select-evidence.ts).
 * Degradation-tier templates (temporal-grounding / evidence-index) use
 * strictly NEUTRAL phrasing: they count and date what recall returned and
 * never assert sufficiency ("the answer", "confirms", …) — sufficiency
 * claims would poison abstention questions (missed-abstention guardrail).
 *
 * Provenance rule: the resolved evidence date is the CONVERSATION's date and
 * is labeled as such ("conversation dated D"); a date is presented as the
 * EVENT's date only when the content's own quoted date phrase parses to the
 * same calendar date. A "derived" note is an authority signal to the
 * answerer — when a session date is phrased as an event date, it overrides
 * correct in-content relative-date reasoning. The same deference applies to
 * counts: candidates, never authoritative totals.
 */
import type { SessionGroup, SynthesisItem, SynthesisMethod } from '../types.js'
import type { SelectedEvidence } from './select-evidence.js'
import type { PreferenceHit } from './preference.js'
import { daysBetween, humanizeDays, orderChronologically, type DatedEvidence } from './temporal.js'
import { groupInstances, type LabeledEvidence } from './aggregate.js'
import { resolveEventDate, isoDate, parseEventDate } from '../utils/event-date.js'

export const BLOCK_HEADER =
  '### Derived from memory (computed deterministically — verify against the memories above; may be incomplete or irrelevant to the question)'

export interface RenderedSection {
  text: string
  items: SynthesisItem[]
  method: SynthesisMethod
  evidenceCount: number
  llmSelectionUsed: boolean
}

const QUOTE_MAX = 80

function quote(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  // Astral characters (emoji, etc.) are multi-byte; use codepoint-safe truncation
  const cps = Array.from(t)
  return cps.length <= QUOTE_MAX ? t : `${cps.slice(0, QUOTE_MAX - 1).join('')}…`
}

function sid(sessionId: string | null): string {
  return sessionId ?? 'unknown session'
}

function nowDelta(date: Date, now: Date): string {
  const days = daysBetween(date, now)
  return days >= 0
    ? `${humanizeDays(days)} before the question date`
    : `${humanizeDays(-days)} after the question date`
}

/** Rendered delta clause, or '' — a same-day "0 days" clause carries no
 *  event information and its salience displaces content-based reasoning. */
function nowDeltaClause(date: Date, now: Date | null, separator: string): string {
  if (!now || daysBetween(date, now) === 0) return ''
  return `${separator}${nowDelta(date, now)}`
}

// ---------------------------------------------------------------------------
// LLM-selected paths
// ---------------------------------------------------------------------------

export function renderTemporalBlock(
  selected: readonly SelectedEvidence[],
  now: Date | null,
): RenderedSection | null {
  const dated: Array<DatedEvidence & { dateText: string | null; evidenced: boolean }> = []
  for (const s of selected) {
    const d = resolveEventDate(s.memory.metadata)
    if (!d) continue // undated evidence is EXCLUDED from arithmetic — never guessed
    // Event-evidenced only when the content's quoted date phrase parses to
    // the same calendar date; the resolved date is otherwise just the
    // conversation's date (see module doc).
    const quoted = s.dateText ? parseEventDate(s.dateText) : null
    dated.push({
      memoryId: s.memory.id,
      sessionId: s.memory.sessionId ?? null,
      date: d,
      snippet: quote(s.memory.content),
      dateText: s.dateText,
      evidenced: quoted !== null && isoDate(quoted) === isoDate(d),
    })
  }
  if (dated.length === 0) return null

  const ordered = orderChronologically(dated) as Array<DatedEvidence & { dateText: string | null; evidenced: boolean }>
  const lines: string[] = []
  const items: SynthesisItem[] = []

  for (const e of ordered) {
    const mention = e.dateText ? ` (mentions "${e.dateText}")` : ''
    const rel = nowDeltaClause(e.date, now, ', ')
    lines.push(e.evidenced
      ? `- "${e.snippet}" — event dated ${isoDate(e.date)}${rel}${mention}; session ${sid(e.sessionId)}.`
      : `- "${e.snippet}" — session ${sid(e.sessionId)}, conversation dated ${isoDate(e.date)}${rel}${mention}.`)
    items.push({
      claim: `"${e.snippet}" → ${isoDate(e.date)}`,
      ...(now ? { value: nowDelta(e.date, now) } : {}),
      citations: [{ memoryId: e.memoryId, sessionId: e.sessionId, date: isoDate(e.date) }],
    })
  }
  if (ordered.length >= 2) {
    const allEvidenced = ordered.every((e) => e.evidenced)
    const sequence = ordered.map((e, i) => `(${i + 1}) ${isoDate(e.date)}`).join(' → ')
    lines.push(allEvidenced
      ? `- Chronological order: ${sequence}.`
      : `- Order by conversation date (events may be earlier than their conversations): ${sequence}.`)
    for (let i = 1; i < ordered.length; i++) {
      const days = daysBetween(ordered[i - 1]!.date, ordered[i]!.date)
      lines.push(`- ${allEvidenced ? 'Elapsed' : 'Elapsed between conversations'} from (${i}) to (${i + 1}): ${humanizeDays(days)}.`)
    }
  }
  if (now) lines.push(`- Question anchor date: ${isoDate(now)}.`)

  return {
    text: lines.join('\n'),
    items,
    method: 'date-arithmetic',
    evidenceCount: ordered.length,
    llmSelectionUsed: true,
  }
}

export function renderAggregationBlock(selected: readonly SelectedEvidence[]): RenderedSection | null {
  if (selected.length === 0) return null
  const labeled: LabeledEvidence[] = selected.map((s) => ({
    memoryId: s.memory.id,
    sessionId: s.memory.sessionId ?? null,
    date: resolveEventDate(s.memory.metadata),
    snippet: quote(s.memory.content),
    instance: s.instance,
  }))
  const groups = groupInstances(labeled)
  const sessionCount = new Set(labeled.map((l) => l.sessionId).filter((s) => s !== null)).size

  const enumeration = groups
    .map((g, i) => {
      const first = g.members[0]!
      const when = g.earliest ? `, ${isoDate(g.earliest)}` : ''
      return `(${i + 1}) ${g.label} (${sid(first.sessionId)}${when})`
    })
    .join('; ')

  const lines = [
    `- [aggregation] Candidate instances found in the selected evidence: ${groups.length} — ${enumeration}.`,
    `- Count basis: ${groups.length} candidate instance${groups.length === 1 ? '' : 's'} from ${selected.length} selected evidence line${selected.length === 1 ? '' : 's'} across ${sessionCount} session${sessionCount === 1 ? '' : 's'}. Candidates may be missing or duplicated — verify the final count against the memories above.`,
  ]
  const items: SynthesisItem[] = [
    {
      claim: `distinct instances: ${groups.map((g) => g.label).join('; ')}`,
      value: String(groups.length),
      citations: labeled.map((l) => ({
        memoryId: l.memoryId,
        sessionId: l.sessionId,
        date: l.date ? isoDate(l.date) : null,
      })),
    },
  ]
  return {
    text: lines.join('\n'),
    items,
    method: 'count-enumerate',
    evidenceCount: selected.length,
    llmSelectionUsed: true,
  }
}

// ---------------------------------------------------------------------------
// Constraint section (deterministic, no LLM anywhere on this path)
// ---------------------------------------------------------------------------

export function renderConstraintSection(hits: readonly PreferenceHit[]): RenderedSection {
  const lines: string[] = []
  const items: SynthesisItem[] = []
  for (const h of hits) {
    const when = h.date ? `, ${isoDate(h.date)}` : ''
    lines.push(
      `- [constraint] Stated user preference (${sid(h.sessionId)}${when}): "${quote(h.content)}" ` +
      'Apply this stated preference when answering — do not merely mention it.',
    )
    items.push({
      claim: `stated preference: "${quote(h.content)}"`,
      citations: [{ memoryId: h.memoryId, sessionId: h.sessionId, date: h.date ? isoDate(h.date) : null }],
    })
  }
  return {
    text: lines.join('\n'),
    items,
    method: 'constraint-surface',
    evidenceCount: hits.length,
    llmSelectionUsed: false,
  }
}

// ---------------------------------------------------------------------------
// No-LLM degradation tier (A2 temporal grounding / A3 evidence index).
// Session-level, computed over ALL returned evidence. Used when no selection
// adapter exists or the selection call failed — never when the model
// explicitly returned an empty selection.
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

function datedSessions(sessions: readonly SessionGroup[]): Array<{ group: SessionGroup; date: Date }> {
  return sessions
    .flatMap((group) => {
      const d = group.earliest ? parseEventDate(group.earliest) : null
      return d ? [{ group, date: d }] : []
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime())
}

export function renderTemporalGrounding(
  sessions: readonly SessionGroup[],
  now: Date | null,
): RenderedSection | null {
  const dated = datedSessions(sessions)
  if (dated.length === 0) return null
  const lines = ['- Temporal grounding (computed from all retrieved evidence):']
  const items: SynthesisItem[] = []
  for (const { group, date } of dated) {
    const rel = nowDeltaClause(date, now, ' — ')
    const n = group.memoryIds.length
    lines.push(
      `- Session ${group.sessionId}: ${isoDate(date)} (${WEEKDAYS[date.getUTCDay()]})${rel}; ${n} matched memor${n === 1 ? 'y' : 'ies'}.`,
    )
    items.push({
      claim: `session ${group.sessionId} → ${isoDate(date)}`,
      ...(now ? { value: nowDelta(date, now) } : {}),
      citations: group.memoryIds.map((memoryId) => ({ memoryId, sessionId: group.sessionId, date: isoDate(date) })),
    })
  }
  if (dated.length >= 2) {
    lines.push(`- Session order (oldest → newest): ${dated.map((d, i) => `(${i + 1}) ${d.group.sessionId} ${isoDate(d.date)}`).join(' → ')}.`)
    for (let i = 1; i < dated.length; i++) {
      lines.push(`- Elapsed from (${i}) to (${i + 1}): ${humanizeDays(daysBetween(dated[i - 1]!.date, dated[i]!.date))}.`)
    }
  }
  if (now) lines.push(`- Question anchor date: ${isoDate(now)}.`)
  return {
    text: lines.join('\n'),
    items,
    method: 'temporal-grounding',
    evidenceCount: dated.length,
    llmSelectionUsed: false,
  }
}

export function renderEvidenceIndex(sessions: readonly SessionGroup[]): RenderedSection | null {
  if (sessions.length === 0) return null
  const dated = datedSessions(sessions)
  const span = dated.length > 0 ? `, spanning ${isoDate(dated[0]!.date)} → ${isoDate(dated[dated.length - 1]!.date)}` : ''
  const ordered = dated.length === sessions.length ? dated.map((d) => d.group) : [...sessions]
  const lines = [
    `- Evidence index: ${sessions.length} distinct sessions matched${span}.`,
    ...ordered.map((g, i) => {
      const n = g.memoryIds.length
      const when = g.earliest ? ` (${g.earliest})` : ''
      return `- (${i + 1}) ${g.sessionId}${when} — ${n} matched memor${n === 1 ? 'y' : 'ies'}.`
    }),
  ]
  const items: SynthesisItem[] = [
    {
      claim: `distinct sessions matched: ${sessions.map((s) => s.sessionId).join(', ')}`,
      value: String(sessions.length),
      citations: sessions.flatMap((g) =>
        g.memoryIds.map((memoryId) => ({ memoryId, sessionId: g.sessionId, date: g.earliest }))),
    },
  ]
  return {
    text: lines.join('\n'),
    items,
    method: 'evidence-index',
    evidenceCount: sessions.length,
    llmSelectionUsed: false,
  }
}
