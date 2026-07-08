import type { RetrievedMemory } from '../types.js'
import type { IntelligenceAdapter, EvidenceItem } from '../adapters/intelligence.js'
import { resolveEventDate, isoDate } from '../utils/event-date.js'

/** Selection input is bounded regardless of maxResults: 30 lines × 120 chars. */
const MAX_EVIDENCE_LINES = 30
const MAX_LINE_CHARS = 120

export interface SelectedEvidence {
  memory: RetrievedMemory
  /** Normalized (lowercased, trimmed) instance label; defaults to a per-index label. */
  instance: string
  /** Verbatim date phrase from the line, or null. Rendered as a quote — NEVER resolved or computed with. */
  dateText: string | null
}

export type SelectionOutcome =
  | { kind: 'selected'; items: SelectedEvidence[] }
  /** The model explicitly said nothing matches → render NO block (abstention safety). */
  | { kind: 'empty' }
  /** Malformed output, invalid indices only, or a thrown call → caller degrades to the deterministic tier. */
  | { kind: 'error' }

export async function runSelection(
  query: string,
  mode: 'temporal' | 'aggregation',
  evidence: readonly RetrievedMemory[],
  intelligence: IntelligenceAdapter,
): Promise<SelectionOutcome> {
  const capped = evidence.slice(0, MAX_EVIDENCE_LINES)
  const lines: EvidenceItem[] = capped.map((m, index) => {
    const d = resolveEventDate(m.metadata)
    return {
      index,
      text: m.content.slice(0, MAX_LINE_CHARS),
      ...(d ? { date: isoDate(d) } : {}),
    }
  })

  try {
    const res = await intelligence.selectEvidence!(query, lines, { mode })
    if (!res || !Array.isArray(res.items)) return { kind: 'error' }
    if (res.items.length === 0) return { kind: 'empty' }

    const seen = new Set<number>()
    const items: SelectedEvidence[] = []
    for (const it of res.items) {
      const idx = (it as { index?: unknown })?.index
      if (typeof idx !== 'number' || !Number.isInteger(idx)) continue
      if (idx < 0 || idx >= capped.length || seen.has(idx)) continue
      seen.add(idx)
      const instance = typeof it.instance === 'string' && it.instance.trim().length > 0
        ? it.instance.trim().toLowerCase()
        : `instance-${idx}`
      const dateText = typeof it.dateText === 'string' && it.dateText.trim().length > 0
        ? it.dateText.trim()
        : null
      items.push({ memory: capped[idx]!, instance, dateText })
    }
    // Non-empty raw items that ALL failed validation is malformed output, not
    // an explicit abstention — degrade rather than silently rendering nothing.
    if (items.length === 0) return { kind: 'error' }
    return { kind: 'selected', items }
  } catch {
    return { kind: 'error' }
  }
}
