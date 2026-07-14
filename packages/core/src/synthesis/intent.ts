/**
 * Synthesis intent router. Deliberately SEPARATE from retrieval/query-
 * classifier.ts: that classifier is calibrated for HyDE, where a false
 * positive costs one cheap extra call; here a false positive costs an LLM
 * selection call plus a potentially irrelevant block in the consumer's
 * context, and a false negative costs nothing but missed upside (recall is
 * byte-identical to baseline). Coverage was repaired against the measured
 * failure of the original spec (~50% temporal fire rate): the order-of-
 * events family, singular time units ("a week ago"), "most recently",
 * "how long", "passed/elapsed since", and bare "how many <noun>" all route.
 * Fire rates are pinned against all 500 real benchmark questions in
 * packages/core/test/synthesis/intent-fixture.test.ts — change regexes and
 * that fixture together, deliberately.
 */

export const TEMPORAL_INTENT_RES: readonly RegExp[] = [
  /\bhow long\b/i,
  /\bhow many (?:days?|weeks?|months?|years?|hours?|minutes?)\b/i,
  /\bhow much time\b/i,
  /\bwhen (?:did|was|were|do|does|is|had)\b/i,
  /\bwhat (?:year|month|date|day|time)\b/i,
  /\b(?:days?|weeks?|months?|years?|hours?)\s+(?:ago|apart|before|after|between|since|until|passed|elapsed|later|earlier|prior)\b/i,
  /\b(?:passed|elapsed)\s+(?:since|between|from)\b/i,
  /\b(?:first|last|earliest|latest)\s+time\b/i,
  /\bmost recent(?:ly)?\b/i,
  // The "order of events" family (entirely unrouted in the original spec)
  /\b(?:order|sequence)\b.{0,80}\b(?:first|last|earliest|latest|events?)\b/i,
  /\bfrom (?:first|earliest) to (?:last|latest)\b/i,
  /\b(?:happened|occurred|came|took place)\s+(?:first|last|earlier|earliest|later|latest)\b/i,
  /\b(?:which|who)\b.{0,60}\b(?:first|last|earlier|later)\b/i,
  /\bbefore or after\b/i,
  /\bon what (?:day|date)\b/i,
]

export const AGGREGATION_INTENT_RES: readonly RegExp[] = [
  /\bhow many\b/i, // bare form — the dominant multi-session miscount phrasing
  /\bhow (?:often|much)\b/i,
  /\b(?:in total|altogether|combined|total (?:number|amount|count)|number of|count of|sum of)\b/i,
  /\b(?:list|name) (?:all|every|each)\b/i,
  /\ball (?:the|of the)\b.{0,60}\b(?:I|we|my)\b/i,
]

export const PREFERENCE_REQUEST_RES: readonly RegExp[] = [
  /\b(?:recommend|suggest)(?:ations?|ions?|ed|s)?\b/i,
  /\b(?:advice|advise)\b/i,
  /\bwhat should i\b/i,
  /\bany (?:good\s+)?(?:tips|ideas?|recommendations?|suggestions?)\b/i,
  /\bany\b.{0,50}\b(?:recommendations?|suggestions?|tips|ideas?)\b/i,
  /\bhelp me (?:choose|pick|find|plan|decide)\b/i,
  /\btips (?:for|on)\b/i,
  /\bhelpful tips\b/i,
  /\bwhat do you think\b/i,
  /\bdo you think\b/i,
  /\blooking for\b/i,
]

/** "What did you recommend…" asks to RETRIEVE a past recommendation — not a
 *  live request that stored preferences should constrain. */
export const PAST_ASSISTANT_RE =
  /\b(?:what|which)\b.{0,30}\b(?:did|had|have)\s+you\b|\byou (?:recommended|suggested|advised|mentioned|told|gave)\b/i

/** Precedence: temporal > aggregation ("how many days between" is temporal). */
export function classifyComputeIntent(query: string): 'temporal' | 'aggregation' | 'none' {
  if (TEMPORAL_INTENT_RES.some((re) => re.test(query))) return 'temporal'
  if (AGGREGATION_INTENT_RES.some((re) => re.test(query))) return 'aggregation'
  return 'none'
}

/** Query-side half of the both-sides-required preference gate; the memory
 *  side (a preference-typed memory in the retrieved set) lives in
 *  synthesis/preference.ts and is ANDed in by the orchestrator. */
export function isPreferenceRequest(query: string): boolean {
  if (PAST_ASSISTANT_RE.test(query)) return false
  return PREFERENCE_REQUEST_RES.some((re) => re.test(query))
}
