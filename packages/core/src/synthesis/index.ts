/**
 * Synthesis orchestrator (opt-in `synthesize` recall mode).
 *
 * Flow: intent gate → evidence scope (maxEvidenceSessions over the A1
 * session ranking) → compute section (OPT-IN via includeComputeNotes; LLM
 * selection when available; deterministic A2/A3 degradation tier on adapter
 * absence/failure; NOTHING on an explicit empty selection) → constraint
 * section (both-sides gate, cap 3) → date-anchoring hard guard → one
 * SynthesisBlock. By default only the preference constraint path renders —
 * it is code-only (no LLM call) and the one section with a significant
 * judged gain under current answerers (see SynthesizeOpts.includeComputeNotes).
 *
 * Error isolation: any throw anywhere returns null — recall NEVER fails
 * because of synthesis.
 */
import type { RetrievedMemory, SessionGroup, SynthesisBlock, SynthesisItem, SynthesisMethod, SynthesizeOpts } from '../types.js'
import type { IntelligenceAdapter } from '../adapters/intelligence.js'
import { rankSessions } from '../retrieval/session-ordering.js'
import { classifyComputeIntent, isPreferenceRequest } from './intent.js'
import { runSelection } from './select-evidence.js'
import { scanPreferences } from './preference.js'
import { validateDatesAnchored } from './temporal.js'
import { resolveEventDate, isoDate } from '../utils/event-date.js'
import {
  BLOCK_HEADER, renderTemporalBlock, renderAggregationBlock,
  renderConstraintSection, renderTemporalGrounding, renderEvidenceIndex,
  type RenderedSection,
} from './render.js'

const MAX_CONSTRAINTS = 3

export interface SynthesizeInput {
  query: string
  memories: readonly RetrievedMemory[]
  /** A1 ranking; computed internally when absent. */
  sessions?: readonly SessionGroup[]
  intelligence?: IntelligenceAdapter
  /** Anchor for now-relative arithmetic (bench: the question date). Without
   *  it, only inter-evidence deltas/orderings are rendered. */
  now?: Date | null
  opts?: SynthesizeOpts
}

export async function synthesize(input: SynthesizeInput): Promise<SynthesisBlock | null> {
  try {
    const compute = input.opts?.includeComputeNotes === true ? classifyComputeIntent(input.query) : 'none'
    const prefRequest = isPreferenceRequest(input.query)
    if (compute === 'none' && !prefRequest) return null
    if (input.memories.length === 0) return null

    const allSessions = input.sessions ?? rankSessions(input.memories)
    const maxSessions = input.opts?.maxEvidenceSessions
    let evidence: readonly RetrievedMemory[] = input.memories
    let sessions: readonly SessionGroup[] = allSessions
    if (maxSessions !== undefined && maxSessions > 0 && allSessions.length > 0) {
      sessions = allSessions.slice(0, maxSessions)
      const allowed = new Set(sessions.map((s) => s.sessionId))
      evidence = input.memories.filter((m) => m.sessionId != null && allowed.has(m.sessionId))
    }
    if (evidence.length === 0) return null

    const now = input.now ?? null
    const sections: RenderedSection[] = []

    if (compute !== 'none') {
      const section = await deriveComputeSection(input.query, compute, evidence, sessions, now, input.intelligence)
      if (section) {
        // Date-anchoring HARD GUARD: every ISO date in the rendered section
        // must be a source evidence event date or the now anchor. A block
        // with an invented date is strictly worse than no block — drop it.
        const allowed = new Set<string>()
        for (const m of evidence) {
          const d = resolveEventDate(m.metadata)
          if (d) allowed.add(isoDate(d))
        }
        if (now) allowed.add(isoDate(now))
        if (validateDatesAnchored(section.text, allowed)) sections.push(section)
      }
    }

    if (prefRequest) {
      const hits = scanPreferences(evidence).slice(0, MAX_CONSTRAINTS)
      if (hits.length > 0) sections.push(renderConstraintSection(hits))
    }

    if (sections.length === 0) return null

    const primary = sections[0]!
    const intent: SynthesisBlock['intent'] =
      primary.method === 'constraint-surface' ? 'preference' : compute === 'none' ? 'preference' : compute
    const method: SynthesisMethod = primary.method
    const items: SynthesisItem[] = sections.flatMap((s) => s.items)
    return {
      intent,
      method,
      text: [BLOCK_HEADER, ...sections.map((s) => s.text)].join('\n'),
      items,
      evidenceCount: sections.reduce((sum, s) => sum + s.evidenceCount, 0),
      llmSelectionUsed: sections.some((s) => s.llmSelectionUsed),
    }
  } catch (err) {
    console.error('[engram] synthesis error (recall unaffected):', err)
    return null
  }
}

async function deriveComputeSection(
  query: string,
  mode: 'temporal' | 'aggregation',
  evidence: readonly RetrievedMemory[],
  sessions: readonly SessionGroup[],
  now: Date | null,
  intelligence: IntelligenceAdapter | undefined,
): Promise<RenderedSection | null> {
  if (intelligence?.selectEvidence) {
    let outcome
    try {
      outcome = await runSelection(query, mode, evidence, intelligence)
    } catch {
      outcome = { kind: 'error' as const }
    }
    if (outcome.kind === 'empty') return null // model said nothing matches — render NOTHING
    if (outcome.kind === 'selected') {
      return mode === 'temporal'
        ? renderTemporalBlock(outcome.items, now)
        : renderAggregationBlock(outcome.items)
    }
    // 'error' falls through to the deterministic tier
  }
  return mode === 'temporal'
    ? renderTemporalGrounding(sessions, now)
    : renderEvidenceIndex(sessions)
}
