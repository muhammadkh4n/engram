// Phase 0 — label a question's recall STRUCTURE so graphEffect is measured on
// the graph-relevant split (multi_hop/temporal, where spreading activation
// should help) instead of the saturated aggregate. Deterministic by design:
// no LLM in the gate path, so the committed labels are reproducible.

export type RecallStructure = 'lookup' | 'multi_hop' | 'temporal' | 'aggregation'

export interface QuestionContext {
  question: string
  goldAnswer: string
  /** Gold evidence ids: LoCoMo dia ids, or LongMemEval answer_session_ids. */
  goldIds: string[]
  /** LoCoMo category if known: 1=single_hop 2=multi_hop 3=temporal 4=open_domain 5=adversarial. */
  category?: number
  /** LongMemEval ability if known: temporal_reasoning, multi_session_reasoning, ... */
  ability?: string
}

export interface RecallStructureLabel {
  type: RecallStructure
  confidence: number
  reasoning: string
}

/** The structures where graph spreading activation is expected to add lift. */
export const GRAPH_RELEVANT: ReadonlySet<RecallStructure> = new Set(['multi_hop', 'temporal'])

// Low-confidence fallback signal only (used when neither category nor ability
// is available). Years, month names, and ordering/relative-time words.
const TEMPORAL_RE =
  /\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(yesterday|today|tomorrow|week|month|year|date|when|before|after|since|until|earlier|later|ago|first|last|recent)\b/i

/**
 * Classify a question's recall structure. Authoritative dataset signals win:
 * LoCoMo `category` first, then LongMemEval `ability`. Only when neither is
 * present do we fall back to structural heuristics (gold cardinality + a
 * temporal-token scan).
 */
export function classifyRecallStructure(ctx: QuestionContext): RecallStructureLabel {
  // 1. LoCoMo category — authoritative.
  if (ctx.category != null) {
    switch (ctx.category) {
      case 2: return { type: 'multi_hop', confidence: 0.9, reasoning: 'LoCoMo category 2 (multi_hop)' }
      case 3: return { type: 'temporal', confidence: 0.9, reasoning: 'LoCoMo category 3 (temporal)' }
      case 1: return { type: 'lookup', confidence: 0.9, reasoning: 'LoCoMo category 1 (single_hop)' }
      case 4: return { type: 'lookup', confidence: 0.7, reasoning: 'LoCoMo category 4 (open_domain) -> lookup' }
      case 5: return { type: 'lookup', confidence: 0.6, reasoning: 'LoCoMo category 5 (adversarial) -> lookup' }
    }
  }

  // 2. LongMemEval ability — authoritative.
  if (ctx.ability) {
    const a = ctx.ability.toLowerCase()
    if (a.includes('temporal')) return { type: 'temporal', confidence: 0.85, reasoning: `ability=${ctx.ability}` }
    if (a.includes('multi_session') || a.includes('multi-session')) return { type: 'multi_hop', confidence: 0.85, reasoning: `ability=${ctx.ability}` }
    if (a.includes('knowledge_update')) return { type: 'multi_hop', confidence: 0.7, reasoning: `ability=${ctx.ability} (updates link sessions)` }
    if (a.includes('information_extraction')) return { type: 'lookup', confidence: 0.8, reasoning: `ability=${ctx.ability}` }
    if (a.includes('abstention')) return { type: 'lookup', confidence: 0.7, reasoning: `ability=${ctx.ability}` }
  }

  // 3. Heuristic fallback.
  const text = `${ctx.question} ${ctx.goldAnswer}`
  if (ctx.goldIds.length >= 3) {
    return { type: 'aggregation', confidence: 0.6, reasoning: `${ctx.goldIds.length} gold ids -> synthesis` }
  }
  if (TEMPORAL_RE.test(text)) {
    return { type: 'temporal', confidence: 0.55, reasoning: 'temporal token in question/answer' }
  }
  if (ctx.goldIds.length >= 2) {
    return { type: 'multi_hop', confidence: 0.6, reasoning: `${ctx.goldIds.length} gold ids -> cross-session` }
  }
  return { type: 'lookup', confidence: 0.5, reasoning: 'single gold id, no temporal signal' }
}
