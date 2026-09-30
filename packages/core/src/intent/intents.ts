import type { IntentType, RetrievalStrategy } from '../types.js'

// ---------------------------------------------------------------------------
// Intent Patterns
// ---------------------------------------------------------------------------

/**
 * Regex patterns used to classify an incoming message into an IntentType.
 * SOCIAL and INFORMATIONAL have special handling in the classification logic;
 * all others are scored by match count.
 */
export const INTENT_PATTERNS: Record<IntentType, RegExp[]> = {
  TASK_START: [
    /\b(let'?s|i need to|i want to|we should|build|create|implement|add|make)\b/i,
    /\b(start|begin|set up|initialize)\b.*\b(project|feature|module|component)\b/i,
  ],
  TASK_CONTINUE: [
    /\b(next|continue|proceed|go on|where were we|what'?s next)\b/i,
    /\b(step \d|move on|keep going)\b/i,
  ],
  QUESTION: [
    /\?$/,
    /\b(what|who|where|when|why|how|which|explain|describe|tell me)\b/i,
  ],
  RECALL_EXPLICIT: [
    /\b(remember|recall|we (discussed|talked|decided|agreed)|last time|previously)\b/i,
    /\b(what did (we|i|you)|did we ever|have we)\b/i,
  ],
  DEBUGGING: [
    /\b(error|bug|broken|fail|crash|exception|not working|issue|wrong)\b/i,
    /\b(debug|fix|troubleshoot|investigate)\b/i,
    /^(Error|TypeError|ReferenceError|SyntaxError):/,
  ],
  PREFERENCE: [
    /\b(i (prefer|like|want|hate|dislike|never|always))\b/i,
    /\b(don'?t (use|do|make|add)|please (always|never))\b/i,
  ],
  REVIEW: [
    /\b(review|check|look at|audit|inspect|lgtm)\b/i,
    /\b(code review|pr review|pull request)\b/i,
  ],
  CONTEXT_SWITCH: [
    /\b(actually|instead|switch|change topic|different thing|forget that)\b/i,
    /\b(let'?s talk about|moving on to|pivoting to)\b/i,
  ],
  EMOTIONAL: [
    /\b(critical|urgent|asap|important|priority|production( is)? down)\b/i,
    /\b(frustrated|confused|stuck|blocked|desperate)\b/i,
    /!{2,}/, // multiple exclamation marks
  ],
  SOCIAL: [
    /^(hi|hey|hello|thanks|thank you|ok|okay|sure|yes|no|yep|nope|lol|haha)\s*[.!]?$/i,
    /^[\p{Emoji}\s]+$/u,
  ],
  INFORMATIONAL: [], // default fallback — no patterns needed
}

// ---------------------------------------------------------------------------
// Strategy Table
// ---------------------------------------------------------------------------

/**
 * Full retrieval strategy for each IntentType as specified in Section 5.1.
 */
export const STRATEGY_TABLE: Record<IntentType, RetrievalStrategy> = {
  TASK_START: {
    shouldRecall: true,
    tiers: [
      { tier: 'semantic', weight: 1.5, recencyBias: 0.3 },
      { tier: 'procedural', weight: 1.5, recencyBias: 0.2 },
      { tier: 'episode', weight: 0.8, recencyBias: 0.6 },
    ],
    queryTransform: null,
    maxResults: 10,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 2,
    boostProcedural: true,
  },

  TASK_CONTINUE: {
    shouldRecall: true,
    tiers: [
      { tier: 'episode', weight: 1.5, recencyBias: 0.8 },
      { tier: 'digest', weight: 1.0, recencyBias: 0.5 },
    ],
    queryTransform: null,
    maxResults: 8,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 1,
    boostProcedural: true,
  },

  QUESTION: {
    shouldRecall: true,
    tiers: [
      { tier: 'semantic', weight: 1.5, recencyBias: 0.2 },
      { tier: 'episode', weight: 1.0, recencyBias: 0.5 },
      { tier: 'digest', weight: 0.8, recencyBias: 0.4 },
    ],
    queryTransform: null,
    maxResults: 10,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 1,
    boostProcedural: false,
  },

  RECALL_EXPLICIT: {
    shouldRecall: true,
    tiers: [
      { tier: 'episode', weight: 1.0, recencyBias: 0.5 },
      { tier: 'digest', weight: 1.0, recencyBias: 0.5 },
      { tier: 'semantic', weight: 1.0, recencyBias: 0.3 },
      { tier: 'procedural', weight: 1.0, recencyBias: 0.3 },
    ],
    queryTransform: null,
    maxResults: 15,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 2,
    boostProcedural: false,
  },

  DEBUGGING: {
    shouldRecall: true,
    tiers: [
      { tier: 'episode', weight: 1.5, recencyBias: 0.7 },
      { tier: 'semantic', weight: 1.2, recencyBias: 0.3 },
      { tier: 'procedural', weight: 0.8, recencyBias: 0.4 },
    ],
    queryTransform: null,
    maxResults: 10,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 1,
    boostProcedural: true,
  },

  PREFERENCE: {
    shouldRecall: true,
    tiers: [
      { tier: 'semantic', weight: 1.5, recencyBias: 0.2 },
    ],
    queryTransform: null,
    maxResults: 8,
    minRelevance: 0.15,
    includeAssociations: false,
    associationHops: 0,
    boostProcedural: false,
  },

  REVIEW: {
    shouldRecall: true,
    tiers: [
      { tier: 'procedural', weight: 1.5, recencyBias: 0.3 },
      { tier: 'semantic', weight: 1.0, recencyBias: 0.2 },
    ],
    queryTransform: null,
    maxResults: 10,
    minRelevance: 0.15,
    includeAssociations: false,
    associationHops: 0,
    boostProcedural: true,
  },

  CONTEXT_SWITCH: {
    shouldRecall: true,
    tiers: [
      { tier: 'semantic', weight: 1.2, recencyBias: 0.3 },
      { tier: 'episode', weight: 1.0, recencyBias: 0.5 },
    ],
    queryTransform: null,
    maxResults: 10,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 1,
    boostProcedural: true,
  },

  EMOTIONAL: {
    shouldRecall: true,
    tiers: [
      { tier: 'episode', weight: 1.2, recencyBias: 0.6 },
      { tier: 'digest', weight: 1.2, recencyBias: 0.5 },
      { tier: 'semantic', weight: 1.2, recencyBias: 0.3 },
      { tier: 'procedural', weight: 1.2, recencyBias: 0.3 },
    ],
    queryTransform: null,
    maxResults: 12,
    minRelevance: 0.15,
    includeAssociations: true,
    associationHops: 2,
    boostProcedural: true,
  },

  SOCIAL: {
    shouldRecall: false,
    tiers: [],
    queryTransform: null,
    maxResults: 0,
    minRelevance: 1.0,
    includeAssociations: false,
    associationHops: 0,
    boostProcedural: false,
  },

  INFORMATIONAL: {
    shouldRecall: true,
    tiers: [
      { tier: 'semantic', weight: 1.0, recencyBias: 0.3 },
      { tier: 'episode', weight: 0.8, recencyBias: 0.5 },
    ],
    queryTransform: null,
    maxResults: 3,
    minRelevance: 0.15,
    includeAssociations: false,
    associationHops: 0,
    boostProcedural: false,
  },
}

// ---------------------------------------------------------------------------
// Vector-First: 3-Mode Classification + Strategies
// ---------------------------------------------------------------------------

import type { RecallMode, RecallStrategy } from '../types.js'

// Whole-message acknowledgements and continuations. Anchored at both ends so a
// sentence that starts with one of these words ("continue the migration") is
// still a query.
const TRIVIAL_TURN_PATTERN =
  /^(hi|hey|hello|thanks|thank you|ok|okay|sure|yes|no|yep|nope|lol|haha|hmm|ah|oh|done|got it|continue|go ahead|go on|do it|lgtm|yeah|yup|cool|k|kk|yes please|sounds good|nice|great|perfect|proceed)\s*[.!]*$/i

// Pictographs only. \p{Emoji} also matches the digits 0-9, '#' and '*'
// (they can start keycap sequences), which would swallow queries such as a
// tenant id or a PR number.
const EMOJI_ONLY_PATTERN =
  /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0F\s]+$/u

/** Classify a message into one of 3 recall modes.
 *
 *  This is the full classifier: acknowledgements, greetings and emoji-only
 *  messages classify as `'skip'`. Callers that recall on every conversation
 *  turn want that; an explicit lookup does not (see `selectRecallMode`). */
export function classifyMode(message: string): RecallMode {
  const trimmed = message.trim()

  // skip: empty text, acks, greetings, emoji-only. No length floor: short
  // queries are often ticket keys, names or hosts, the highest-signal lookups.
  if (trimmed.length === 0) return 'skip'
  if (TRIVIAL_TURN_PATTERN.test(trimmed)) return 'skip'
  if (EMOJI_ONLY_PATTERN.test(trimmed)) return 'skip'

  // deep: question mark or recall keywords
  if (/\?/.test(trimmed)) return 'deep'
  if (/\b(remember|recall|what did|did we|last time|previously|have we|remind me)\b/i.test(trimmed)) return 'deep'

  // everything else: light
  return 'light'
}

/** Pick the recall mode for a recall call.
 *
 *  An explicit recall (a tool call, an API caller, a benchmark) is a lookup
 *  the caller asked for, so only empty text is skipped: "ok" or "1933" may be
 *  exactly the string being searched for. `skipTrivial` is for callers that
 *  recall on every conversation turn, where acknowledgements and emoji carry
 *  no query and the full classifier applies. */
export function selectRecallMode(
  query: string,
  opts: { skipTrivial?: boolean } = {},
): RecallMode {
  const mode = classifyMode(query)
  if (mode !== 'skip' || opts.skipTrivial === true) return mode
  return query.trim().length === 0 ? 'skip' : 'light'
}

/** Strategy table for the 3 recall modes.
 *
 * `maxResults` is set to 30 for both `light` and `deep` based on
 * the LoCoMo recall sweep at results/forensics/local-recall-sweep-mr30.json:
 * 30 sits at the rerank-dilution sweet spot — small enough that the
 * cross-encoder reliably keeps gold candidates in top-10
 * (recall@10 = 68% on conv-26 in degraded mode, beating the
 * production-mode baseline of 67%), large enough that recall@30
 * captures another +3pp of golds the reranker disperses to positions
 * 11-30. mr50 is the dilution cliff (recall@10 collapses to 33%);
 * mr15-20 leaves recall@30 capacity unused. See
 * results/forensics/findings.md §"Phase 2b" for the full curve. */
export const RECALL_STRATEGIES: Record<RecallMode, RecallStrategy> = {
  skip: {
    mode: 'skip',
    maxResults: 0,
    associations: false,
    associationHops: 0,
    expand: false,
    recencyBias: 0,
  },
  light: {
    mode: 'light',
    maxResults: 30,
    associations: false,
    associationHops: 0,
    expand: false,
    recencyBias: 0.4,
  },
  deep: {
    mode: 'deep',
    maxResults: 30,
    associations: true,
    associationHops: 2,
    expand: true,
    recencyBias: 0.2,
  },
}
