/**
 * Lightweight query classifier for retrieval strategy selection.
 *
 * Heuristic detection of multi-hop and temporal queries to drive:
 *  - HyDE always-on (not just topScore<0.3 fallback)
 *  - Future: query decomposition for multi-hop, temporal-aware reranker
 *
 * Evidence base (no full benchmarks — regex heuristics calibrated against
 * patterns reported in the literature):
 *  - M3GQA (ACL 2025): multi-hop questions avg 2.66 hops, 3.43 entities;
 *    single-hop avg ~1 hop, 4 entities. Entity count ≥ 2 combined with
 *    relational language is a reasonable multi-hop signal.
 *  - Stanford CS224N Deep Retriever paper: multi-hop heuristics use
 *    capitalized-span NER + relational tokens as query-type labels.
 *  - arXiv 2602.23372 (linear-time GraphRAG): regex NER pattern
 *    `\b[A-Z][a-z]+(\s+[A-Z][a-z]+){0,3}\b` is orders of magnitude faster
 *    than spaCy and competitive for entity counting in retrieval.
 */

/**
 * Regex that matches 1-4 token capitalized spans ("Alice", "New York",
 * "San Francisco Bay Area"). Used as a cheap NER proxy for entity counting.
 * Cited directly from arXiv 2602.23372's linear-time GraphRAG pipeline.
 */
const CAPITALIZED_ENTITY_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/g

/**
 * Words a question shouldn't count as entities when they appear
 * capitalized only because they're sentence-initial. The classifier
 * only uses capitalized NER as a proxy, so we strip interrogatives that
 * often lead questions ("What", "When", "Where", etc.).
 */
const STOPWORD_CAPITALIZED = new Set([
  'What', 'When', 'Where', 'Who', 'Why', 'Which', 'How', 'Did',
  'Do', 'Does', 'Is', 'Was', 'Were', 'Are', 'Can', 'Could', 'Would',
  'Should', 'Will', 'Have', 'Has', 'Had', 'Tell', 'Explain', 'Describe',
  'Before', 'After', 'During',
])

/**
 * Extract capitalized entity spans from a query, skipping stopword
 * interrogatives. Not a replacement for real NER — a fast heuristic
 * for classification routing only.
 */
export function extractCapitalizedEntities(query: string): string[] {
  const matches = query.match(CAPITALIZED_ENTITY_RE) ?? []
  return matches.filter(m => !STOPWORD_CAPITALIZED.has(m.split(' ')[0] ?? ''))
}

/**
 * Relational / multi-hop language markers. When combined with ≥2
 * entities these strongly suggest cross-entity reasoning.
 */
const MULTI_HOP_RELATIONAL_RE = [
  /\b(?:between|among)\b/i,                    // "between X and Y", "among them"
  /\bwhere\s+(?:did|do|does|will|were|was)\b/i, // "where did X and Y meet"
  /\bhow\s+did\s+\w+\s+(?:meet|know|react|find|discover)/i,
  /\bwho\s+(?:else|also)\b/i,
  /\b(?:more|less|fewer|greater|higher|lower|older|younger|taller|shorter)\b/i, // comparatives
  /\b(?:compared\s+to|versus|vs\.?)\b/i,
  /,\s*\w+\s+or\s+\w+\?/i,                     // "..., Jamie or Sansa?" choice question
]

/**
 * Aggregation or counting language — almost always multi-hop against
 * personal-memory corpora (requires scanning multiple sessions).
 */
const AGGREGATION_RE = [
  /\bhow\s+(?:many|often|much)\b/i,
  /\b(?:count|total|sum|number of)\b/i,
  /\b(?:first|last|earliest|latest)\s+time\b/i,
  /\bever\s+(?:since|before|after)\b/i,
]

/**
 * Pattern: two capitalized entities joined by "and" — "Alice and Bob",
 * "Jamie and Sansa". This is the most common multi-hop signal in
 * conversational memory benchmarks (LoCoMo, LongMemEval).
 */
const ENTITIES_CONNECTED_BY_AND = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+and\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/

/**
 * Heuristic: a query is multi-hop if ANY of:
 *   - aggregation / counting language ("how many times", "first time")
 *   - ≥2 capitalized entities connected by "and" ("Alice and Bob")
 *   - ≥2 capitalized entities + any relational marker
 * Errs on the side of over-firing — HyDE is cheap, and a false
 * positive just runs one extra LLM call.
 */
export function isMultiHopQuery(query: string): boolean {
  const hasAggregation = AGGREGATION_RE.some(re => re.test(query))
  if (hasAggregation) return true

  if (ENTITIES_CONNECTED_BY_AND.test(query)) return true

  const entities = extractCapitalizedEntities(query)
  const hasRelational = MULTI_HOP_RELATIONAL_RE.some(re => re.test(query))
  if (entities.length >= 2 && hasRelational) return true

  return false
}

/**
 * Month and weekday names — used for temporal detection after "before/after/during".
 */
const TIME_WORDS = 'january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday'

/**
 * Spelled-out small numbers. "Two years ago", "five months ago".
 */
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve'

/**
 * Temporal query markers. Any of these routes to temporal-aware
 * retrieval (HyDE always-on + future calendar-index filter).
 */
const TEMPORAL_RE = [
  /\b(?:when|what\s+(?:year|date|month|day|time))\b/i,
  new RegExp(`\\b(?:before|after|during|since|until|by)\\s+(?:the\\s+|a\\s+|\\d|${TIME_WORDS})\\b`, 'i'),
  /\b(?:yesterday|today|tomorrow|tonight)\b/i,
  new RegExp(`\\b(?:last|this|next|previous|past)\\s+(?:week|month|year|day|time|night|morning|afternoon|evening|weekend|${TIME_WORDS})\\b`, 'i'),
  new RegExp(`\\b(?:a|an|\\d+|${NUMBER_WORDS})\\s+(?:day|week|month|year|hour|minute)s?\\s+ago\\b`, 'i'),
  /\b(?:recently|earlier|later|afterwards|beforehand|meanwhile)\b/i,
  /\bin\s+(?:19|20)\d{2}\b/,
  /\b(?:19|20)\d{2}\b/,
  /\bhow\s+long\s+(?:ago|between|did|since|until)\b/i,
]

/**
 * Detect temporal queries. Broad net — any time reference triggers
 * temporal-aware retrieval.
 */
export function isTemporalQuery(query: string): boolean {
  return TEMPORAL_RE.some(re => re.test(query))
}

/**
 * Combined classification: returns flags that downstream retrieval
 * can use to adjust strategy (HyDE firing, rerank weighting, etc).
 */
export interface QuerySignals {
  multiHop: boolean
  temporal: boolean
  entityCount: number
}

export function classifyQuery(query: string): QuerySignals {
  return {
    multiHop: isMultiHopQuery(query),
    temporal: isTemporalQuery(query),
    entityCount: extractCapitalizedEntities(query).length,
  }
}
